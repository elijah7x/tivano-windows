# Tivano Windows - derived from Tivano (AGPL-3.0), modified 2026-11-28.
# Droppy Code by Jordy Spruit (Droppy), https://getdroppycode.app
# Usage: .\Invoke-PrePrSelfCheck.ps1 -Worktree <worktree> [-Issue <n>] [-BodyFile <pr-body.md>] [-Base origin/main] [-NoFetch] [-RunChecks] [-MaxWorkers 2]
# Mechanical pre-push self-check for implementer lanes. Catches the findings the merge gate and nyx/audit raise most often
# (conflicts, guarded paths including docs/parity.md, dependency changes, PR-body Parity: lines, missing zh-Hans, license headers, attribution, stray files)
# before a head is pushed. Prints one line per check, then one compact JSON line. Exit 0 = no FAIL, 1 = any FAIL, 2 = bad parameters.
# Never modifies the worktree, index or branches; it runs `git fetch origin` unless -NoFetch, and with -RunChecks it runs
# typecheck and changed test files (Vitest capped via -MaxWorkers) and may add/remove one temporary detached merge-base worktree.

param(
  [Parameter(Mandatory = $true)][string]$Worktree,
  [int]$Issue = 0,
  [string]$BodyFile = '',
  [string]$Base = 'origin/main',
  [switch]$NoFetch,
  [switch]$RunChecks,
  [ValidateRange(1, 32)][int]$MaxWorkers = 2
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
try { [Console]::OutputEncoding = [Text.Encoding]::UTF8 } catch { }

$script:Checks = New-Object 'System.Collections.Generic.List[object]'
$script:Git = $null
$script:Utf8 = New-Object System.Text.UTF8Encoding($false)

function Add-Check {
  param([string]$Name, [string]$Status, [AllowEmptyString()][string]$Detail)
  $script:Checks.Add([pscustomobject]@{ name = $Name; status = $Status; detail = $Detail })
}

function Invoke-Git {
  # Returns @{ code; lines }. stderr is discarded so a native warning never becomes a terminating error.
  param([string[]]$GitArgs)
  $old = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  try {
    $out = @(& $script:Git -C $Worktree @GitArgs 2>$null)
    $code = $LASTEXITCODE
  } finally {
    $ErrorActionPreference = $old
  }
  $lines = New-Object 'System.Collections.Generic.List[string]'
  foreach ($o in $out) { $lines.Add([string]$o) }
  return [pscustomobject]@{ code = $code; lines = $lines.ToArray() }
}

function Read-Utf8 {
  param([string]$Path)
  return [IO.File]::ReadAllText($Path, $script:Utf8)
}

function Join-Limited {
  param([string[]]$Items, [int]$Max = 20)
  $all = @($Items)
  if ($all.Count -le $Max) { return ($all -join '; ') }
  return ((@($all[0..($Max - 1)]) -join '; ') + '; +' + ($all.Count - $Max) + ' more')
}

function Test-UnderPrefix {
  param([string]$Path, [string[]]$Prefixes)
  $p = $Path.Replace('\', '/')
  foreach ($x in $Prefixes) {
    if ($x.EndsWith('/')) {
      if ($p.StartsWith($x, [StringComparison]::OrdinalIgnoreCase)) { return $true }
    } elseif ([string]::Equals($p, $x, [StringComparison]::OrdinalIgnoreCase)) {
      return $true
    }
  }
  return $false
}

# ---- parameters --------------------------------------------------------------

$gitCmd = Get-Command git.exe -ErrorAction SilentlyContinue
if (-not $gitCmd) { $gitCmd = Get-Command git -ErrorAction SilentlyContinue }
if (-not $gitCmd) { Write-Output '[FAIL] setup: git was not found on PATH'; exit 2 }
$script:Git = $gitCmd.Source
if (-not (Test-Path -LiteralPath $Worktree -PathType Container)) { Write-Output ('[FAIL] setup: worktree not found: ' + $Worktree); exit 2 }
$Worktree = (Resolve-Path -LiteralPath $Worktree).Path
$top = Invoke-Git @('rev-parse', '--show-toplevel')
if ($top.code -ne 0) { Write-Output '[FAIL] setup: not a git worktree'; exit 2 }
if ($BodyFile -and -not (Test-Path -LiteralPath $BodyFile -PathType Leaf)) { Write-Output ('[FAIL] setup: body file not found: ' + $BodyFile); exit 2 }
$bodyText = ''
if ($BodyFile) { $bodyText = Read-Utf8 $BodyFile }

$branchRes = Invoke-Git @('rev-parse', '--abbrev-ref', 'HEAD')
$branchName = ''
if ($branchRes.code -eq 0 -and @($branchRes.lines).Count -gt 0) {
  $branchName = ([string]$branchRes.lines[0]).Trim()
}
$isRebaselinePr = ($branchName -like 'nyx/rebaseline-v*')
$isParitySyncPr = ($branchName -like 'nyx/parity-sync-*')
$allowParityMdEdit = ($isRebaselinePr -or $isParitySyncPr)

if (-not $NoFetch) {
  $fetch = Invoke-Git @('fetch', 'origin', '--quiet')
  if ($fetch.code -ne 0) { Add-Check 'fetch' 'WARN' ('git fetch origin failed (exit ' + $fetch.code + '); checks use the last fetched ' + $Base) }
}
$mbRes = Invoke-Git @('merge-base', 'HEAD', $Base)
if ($mbRes.code -ne 0 -or @($mbRes.lines).Count -eq 0) { Write-Output ('[FAIL] setup: cannot resolve merge base with ' + $Base); exit 2 }
$mb = ([string]$mbRes.lines[0]).Trim()

# ---- collect changes (committed + uncommitted + untracked) -------------------

$status = @((Invoke-Git @('status', '--porcelain', '--untracked-files=all')).lines)
$untracked = New-Object 'System.Collections.Generic.List[string]'
$modifiedUncommitted = New-Object 'System.Collections.Generic.List[string]'
foreach ($s in $status) {
  if ($s.Length -lt 4) { continue }
  $path = $s.Substring(3).Trim('"')
  if ($s.StartsWith('??')) { $untracked.Add($path) } else { $modifiedUncommitted.Add($path) }
}

$changedSet = New-Object 'System.Collections.Generic.HashSet[string]' ([StringComparer]::OrdinalIgnoreCase)
foreach ($f in @((Invoke-Git @('diff', '--name-only', $mb)).lines)) { if ($f) { $null = $changedSet.Add($f) } }
foreach ($f in $untracked) { $null = $changedSet.Add($f) }
$changed = @($changedSet | Sort-Object)

$addedSet = New-Object 'System.Collections.Generic.HashSet[string]' ([StringComparer]::OrdinalIgnoreCase)
foreach ($f in @((Invoke-Git @('diff', '--name-only', '--diff-filter=A', $mb)).lines)) { if ($f) { $null = $addedSet.Add($f) } }
foreach ($f in $untracked) { $null = $addedSet.Add($f) }

# Added and removed lines per file, from merge base to the working tree.
$plus = New-Object 'System.Collections.Generic.List[object]'
$minus = New-Object 'System.Collections.Generic.List[object]'
$curFile = ''
$newLine = 0
foreach ($l in @((Invoke-Git @('diff', '--unified=0', '--no-color', '--no-ext-diff', $mb)).lines)) {
  if ($l.StartsWith('+++ ')) {
    $curFile = ''
    if ($l.StartsWith('+++ b/')) { $curFile = $l.Substring(6) }
    continue
  }
  if ($l.StartsWith('--- ')) { continue }
  $m = [regex]::Match($l, '^@@ -\d+(?:,\d+)? \+(\d+)')
  if ($m.Success) { $newLine = [int]$m.Groups[1].Value; continue }
  if (-not $curFile) { continue }
  if ($l.StartsWith('+')) {
    $plus.Add([pscustomobject]@{ file = $curFile; line = $newLine; text = $l.Substring(1) })
    $newLine++
  } elseif ($l.StartsWith('-')) {
    $minus.Add([pscustomobject]@{ file = $curFile; line = 0; text = $l.Substring(1) })
  }
}
foreach ($f in $untracked) {
  $full = Join-Path $Worktree $f
  if (-not (Test-Path -LiteralPath $full -PathType Leaf)) { continue }
  if ((Get-Item -LiteralPath $full).Length -gt 2MB) { continue }
  $n = 1
  foreach ($t in ((Read-Utf8 $full) -split "`r?`n")) {
    $plus.Add([pscustomobject]@{ file = $f; line = $n; text = $t })
    $n++
  }
}
$plusAll = $plus.ToArray()
$minusAll = $minus.ToArray()

# ---- a. conflicts ------------------------------------------------------------

$mt = Invoke-Git @('merge-tree', '--write-tree', '--name-only', 'HEAD', $Base)
if ($mt.code -eq 0) {
  Add-Check 'conflicts' 'PASS' ('merges cleanly with ' + $Base)
} elseif ($mt.code -eq 1) {
  $paths = New-Object 'System.Collections.Generic.List[string]'
  $lines = @($mt.lines)
  for ($i = 1; $i -lt $lines.Count; $i++) {
    if ([string]::IsNullOrWhiteSpace($lines[$i])) { break }
    $paths.Add($lines[$i])
  }
  Add-Check 'conflicts' 'FAIL' ('conflicts with ' + $Base + '; run git merge origin/main and resolve before pushing: ' + (Join-Limited $paths.ToArray()))
} else {
  Add-Check 'conflicts' 'WARN' ('git merge-tree could not run (exit ' + $mt.code + ')')
}

# ---- b. guarded paths --------------------------------------------------------

$guardedList = New-Object 'System.Collections.Generic.List[string]'
foreach ($g in @('scripts/audit/', 'scripts/dev-loop/', 'scripts/pr-review/', 'scripts/windows-acceptance/', '.github/',
    'AGENTS.md', 'CONTRIBUTING.md', 'LICENSE', 'THIRD_PARTY_NOTICES.md', 'TRADEMARK.md', 'package-lock.json')) {
  $guardedList.Add($g)
}
if (-not $isRebaselinePr) { $guardedList.Add('docs/source-baseline.json') }
if (-not $allowParityMdEdit) { $guardedList.Add('docs/parity.md') }
$guarded = $guardedList.ToArray()
$hitGuarded = @($changed | Where-Object { Test-UnderPrefix $_ $guarded })
if ($isParitySyncPr) {
  $nonParity = @($changed | Where-Object { -not [string]::Equals($_.Replace('\', '/'), 'docs/parity.md', [StringComparison]::OrdinalIgnoreCase) })
  if ($nonParity.Count -gt 0) {
    Add-Check 'guarded-paths' 'FAIL' ('parity-sync PRs may only change docs/parity.md: ' + (Join-Limited $nonParity))
  } else {
    Add-Check 'guarded-paths' 'PASS' 'parity-sync PR only touches docs/parity.md'
  }
} elseif ($hitGuarded.Count -gt 0) {
  $hint = ' (put new docs under docs/)'
  if (@($hitGuarded | Where-Object { [string]::Equals($_.Replace('\', '/'), 'docs/parity.md', [StringComparison]::OrdinalIgnoreCase) }).Count -gt 0) {
    $hint = ' (feature PRs must not edit docs/parity.md; declare "Parity: <ID> -> <status>" in the PR body instead; put new docs under docs/)'
  }
  Add-Check 'guarded-paths' 'FAIL' ('issue PRs must not change: ' + (Join-Limited $hitGuarded) + $hint)
} else {
  Add-Check 'guarded-paths' 'PASS' 'no guarded path changed'
}

# ---- c. dependencies ---------------------------------------------------------

function Get-DepMap {
  param($Json)
  $map = @{}
  foreach ($section in @('dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies', 'bundledDependencies', 'bundleDependencies', 'overrides')) {
    $prop = $Json.PSObject.Properties[$section]
    if (-not $prop -or $null -eq $prop.Value) { continue }
    if ($prop.Value -is [pscustomobject]) {
      foreach ($p in $prop.Value.PSObject.Properties) {
        $val = if ($p.Value -is [string] -or $p.Value -is [ValueType]) { [string]$p.Value } else { ConvertTo-Json -InputObject $p.Value -Depth 10 -Compress }
        $map[$section + ':' + $p.Name] = $val
      }
    } else {
      $map[$section] = ConvertTo-Json -InputObject $prop.Value -Depth 10 -Compress
    }
  }
  return $map
}

if ($changedSet.Contains('package.json')) {
  try {
    $baseText = (@((Invoke-Git @('show', ($mb + ':package.json'))).lines) -join "`n")
    $baseDeps = Get-DepMap ($baseText | ConvertFrom-Json)
    $headDeps = Get-DepMap ((Read-Utf8 (Join-Path $Worktree 'package.json')) | ConvertFrom-Json)
    $diffs = New-Object 'System.Collections.Generic.List[string]'
    foreach ($k in @(@($baseDeps.Keys) + @($headDeps.Keys) | Sort-Object -Unique)) {
      $a = if ($baseDeps.ContainsKey($k)) { $baseDeps[$k] } else { '<none>' }
      $b = if ($headDeps.ContainsKey($k)) { $headDeps[$k] } else { '<none>' }
      if ($a -ne $b) { $diffs.Add($k + ' ' + $a + ' -> ' + $b) }
    }
    if ($diffs.Count -gt 0) {
      Add-Check 'dependencies' 'FAIL' ('dependency changes are not allowed in issue PRs: ' + (Join-Limited $diffs.ToArray()))
    } else {
      Add-Check 'dependencies' 'PASS' 'package.json changed but no dependency changed'
    }
  } catch {
    Add-Check 'dependencies' 'FAIL' ('cannot compare package.json dependencies: ' + $_.Exception.Message)
  }
} else {
  Add-Check 'dependencies' 'PASS' 'package.json unchanged'
}

# ---- d. parity ---------------------------------------------------------------

function Get-ParityStatusMap {
  param([string[]]$Lines)
  $map = @{}
  foreach ($line in @($Lines)) {
    if ([string]::IsNullOrWhiteSpace($line)) { continue }
    $m = [regex]::Match($line, '^\s*\|\s*(P\d+-\d+|W-\d+)\s*\|')
    if (-not $m.Success) { continue }
    $cells = [regex]::Split($line, '(?<!\\)\|')
    if ($cells.Count -lt 5) { continue }
    $id = $m.Groups[1].Value.Trim().ToUpperInvariant()
    $map[$id] = $cells[3].Trim().Trim('`').Trim().ToLowerInvariant()
  }
  return $map
}

$baseParityRes = Invoke-Git @('show', ($mb + ':docs/parity.md'))
$baseParityStatus = if ($baseParityRes.code -eq 0) { Get-ParityStatusMap $baseParityRes.lines } else { @{} }
$parityMdChanged = $changedSet.Contains('docs/parity.md')

if ($parityMdChanged -and -not $allowParityMdEdit) {
  Add-Check 'parity-file' 'FAIL' 'feature PRs must not edit docs/parity.md directly; declare "Parity: <ID> -> <status>" (and optional "Parity-Notes: <text>") in the PR body instead'
} elseif ($parityMdChanged) {
  Add-Check 'parity-file' 'PASS' ('docs/parity.md edit allowed on ' + $branchName)
} else {
  Add-Check 'parity-file' 'PASS' 'docs/parity.md unchanged'
}

$docsRowIds = New-Object 'System.Collections.Generic.HashSet[string]' ([StringComparer]::OrdinalIgnoreCase)
if ($parityMdChanged) {
  foreach ($p in @($plusAll | Where-Object { $_.file -eq 'docs/parity.md' })) {
    $idm = [regex]::Match($p.text, '^\s*\|\s*(P\d+-\d+|W-\d+)\s*\|')
    if ($idm.Success) { $null = $docsRowIds.Add($idm.Groups[1].Value.Trim().ToUpperInvariant()) }
  }
  $parityPath = Join-Path $Worktree 'docs\parity.md'
  $headParityLines = if (Test-Path -LiteralPath $parityPath -PathType Leaf) { @((Read-Utf8 $parityPath) -split "`r?`n") } else { @() }
  $headParityStatus = Get-ParityStatusMap $headParityLines
  $newDone = New-Object 'System.Collections.Generic.List[string]'
  $newDeferred = New-Object 'System.Collections.Generic.List[string]'
  $changedDeferred = New-Object 'System.Collections.Generic.List[string]'
  foreach ($id in @($headParityStatus.Keys | Sort-Object)) {
    $headSt = [string]$headParityStatus[$id]
    $baseSt = if ($baseParityStatus.ContainsKey($id)) { [string]$baseParityStatus[$id] } else { '' }
    if ($headSt -match '^done\b' -and $baseSt -notmatch '^done\b') { $newDone.Add($id) }
    if ($headSt -match '^deferred\b' -and $baseSt -notmatch '^deferred\b') { $newDeferred.Add($id) }
  }
  foreach ($id in @($baseParityStatus.Keys | Sort-Object)) {
    $baseSt = [string]$baseParityStatus[$id]
    if ($baseSt -notmatch '^deferred\b') { continue }
    if (-not $headParityStatus.ContainsKey($id) -or [string]$headParityStatus[$id] -ne $baseSt) {
      $changedDeferred.Add($id)
    }
  }
  $parityDoneIssues = New-Object 'System.Collections.Generic.List[string]'
  if ($newDone.Count -gt 0) { $parityDoneIssues.Add('newly set to done: ' + (Join-Limited $newDone.ToArray())) }
  if ($newDeferred.Count -gt 0) { $parityDoneIssues.Add('newly set to deferred: ' + (Join-Limited $newDeferred.ToArray())) }
  if ($changedDeferred.Count -gt 0) { $parityDoneIssues.Add('modified deferred row(s): ' + (Join-Limited $changedDeferred.ToArray())) }
  if ($parityDoneIssues.Count -gt 0) {
    Add-Check 'parity-done' 'FAIL' ('never set a parity row to done or change deferred rows: ' + ($parityDoneIssues.ToArray() -join '; '))
  } else {
    Add-Check 'parity-done' 'PASS' 'no parity row newly set to done or deferred'
  }
} else {
  Add-Check 'parity-done' 'PASS' 'docs/parity.md unchanged'
}

$bodyRowIds = New-Object 'System.Collections.Generic.HashSet[string]' ([StringComparer]::OrdinalIgnoreCase)
if ($BodyFile) {
  $cleanBody = [regex]::Replace($bodyText, '<!--[\s\S]*?-->', '')
  $parityBodyErrors = New-Object 'System.Collections.Generic.List[string]'
  $parityBodyWarns = New-Object 'System.Collections.Generic.List[string]'
  $allowedStatusRe = '(?i)^(?:partial|not started|blocked\s*\(\s*[^)\r\n\s][^)\r\n]*\)|n/a\s*\(\s*macOS-only:\s*[^)\r\n\s][^)\r\n]*\))$'
  $validParityLines = 0
  $hasLastValidParity = $false
  foreach ($rawLine in ($cleanBody -split "`r?`n")) {
    $line = $rawLine.TrimEnd("`r")
    $pmLine = [regex]::Match($line, '(?i)^(\s*(?:[-*+]\s+)?)(Parity\s*:\s*)(.*)$')
    if ($pmLine.Success) {
      $lineBad = $false
      $prefix = $pmLine.Groups[1].Value
      $tag = $pmLine.Groups[2].Value
      $rest = $pmLine.Groups[3].Value.Trim()
      if (-not [string]::IsNullOrEmpty($prefix)) {
        $parityBodyErrors.Add('Parity: line must start at column 0 without a bullet or indent: "' + $line.Trim() + '"')
        $lineBad = $true
      }
      if ($tag -notmatch '(?i)^Parity:') {
        $parityBodyErrors.Add('invalid Parity: prefix (no space before colon): "' + $line.Trim() + '"')
        $lineBad = $true
      }
      $kv = [regex]::Match($rest, '(?i)^(P\d+-\d+|W-\d+)\s*->\s*(.+?)\s*$')
      if (-not $kv.Success) {
        $parityBodyErrors.Add('invalid Parity: format (expected "Parity: <ID> -> <status>"): "' + $line.Trim() + '"')
        $hasLastValidParity = $false
        continue
      }
      $parityId = $kv.Groups[1].Value.Trim().ToUpperInvariant()
      $rawStatus = $kv.Groups[2].Value.Trim()
      $null = $bodyRowIds.Add($parityId)
      $unquotedStatus = $rawStatus.Trim('`').Trim()
      if ($unquotedStatus -match '(?i)^(?:done|deferred)\b') {
        $parityBodyErrors.Add('Parity: ' + $parityId + ' must not propose "' + $unquotedStatus + '" (never done or deferred; use partial with Parity-Notes:)')
        $hasLastValidParity = $false
        continue
      }
      if ($rawStatus.StartsWith('`') -or $rawStatus.EndsWith('`')) {
        $parityBodyErrors.Add('Parity: ' + $parityId + ' status must not be wrapped in backticks: "' + $rawStatus + '"')
        $hasLastValidParity = $false
        continue
      }
      if ($rawStatus -notmatch $allowedStatusRe) {
        $parityBodyErrors.Add('unsupported Parity: status for ' + $parityId + ' ("' + $rawStatus + '"); expected partial, not started, blocked (<reason>), or n/a (macOS-only: <reason>)')
        $hasLastValidParity = $false
        continue
      }
      if ($baseParityStatus.Count -gt 0) {
        if (-not $baseParityStatus.ContainsKey($parityId)) {
          $parityBodyErrors.Add('Parity: ' + $parityId + ' does not exist in docs/parity.md')
          $hasLastValidParity = $false
          continue
        }
        $baseRowSt = [string]$baseParityStatus[$parityId]
        if ($baseRowSt -match '^deferred\b') {
          $parityBodyErrors.Add('Parity: ' + $parityId + ' targets a deferred row in docs/parity.md; never touch deferred rows')
          $hasLastValidParity = $false
          continue
        }
        if ($baseRowSt -match '^done\b') {
          $parityBodyWarns.Add('Parity: ' + $parityId + ' is already marked done in docs/parity.md; parity-sync will leave it unchanged')
        }
      }
      if (-not $lineBad) {
        $validParityLines++
        $hasLastValidParity = $true
      } else {
        $hasLastValidParity = $false
      }
      continue
    }

    $nmLine = [regex]::Match($line, '(?i)^(\s*(?:[-*+]\s+)?)(Parity-Notes\s*:\s*)(.*)$')
    if ($nmLine.Success) {
      $prefix = $nmLine.Groups[1].Value
      $tag = $nmLine.Groups[2].Value
      $noteText = $nmLine.Groups[3].Value.Trim()
      if (-not [string]::IsNullOrEmpty($prefix)) {
        $parityBodyErrors.Add('Parity-Notes: line must start at column 0 without a bullet or indent: "' + $line.Trim() + '"')
      }
      if ($tag -notmatch '(?i)^Parity-Notes:') {
        $parityBodyErrors.Add('invalid Parity-Notes: prefix (no space before colon): "' + $line.Trim() + '"')
      }
      if ([string]::IsNullOrWhiteSpace($noteText)) {
        $parityBodyErrors.Add('Parity-Notes: line must not be empty')
      } elseif (-not $hasLastValidParity) {
        $parityBodyErrors.Add('Parity-Notes: line must follow a valid Parity: <ID> -> <status> line')
      }
    }
  }
  if ($parityBodyErrors.Count -gt 0) {
    Add-Check 'parity-body' 'FAIL' (Join-Limited $parityBodyErrors.ToArray() 10)
  } else {
    Add-Check 'parity-body' 'PASS' ([string]$validParityLines + ' valid Parity: line(s) in PR body')
  }
  if ($parityBodyWarns.Count -gt 0) {
    Add-Check 'parity-body-warn' 'WARN' (Join-Limited $parityBodyWarns.ToArray() 10)
  }
} else {
  Add-Check 'parity-body' 'SKIP' 'needs -BodyFile'
}

$allRowIds = New-Object 'System.Collections.Generic.HashSet[string]' ([StringComparer]::OrdinalIgnoreCase)
foreach ($id in $docsRowIds) { $null = $allRowIds.Add($id) }
foreach ($id in $bodyRowIds) { $null = $allRowIds.Add($id) }
if ($allowParityMdEdit) {
  Add-Check 'parity-rows' 'PASS' ([string]$allRowIds.Count + ' parity row(s) touched (multi-row allowed on ' + $branchName + ')')
} elseif ($allRowIds.Count -gt 1) {
  Add-Check 'parity-rows' 'WARN' ('this PR covers ' + $allRowIds.Count + ' parity rows (' + (Join-Limited @($allRowIds | Sort-Object)) + '); one change does one thing - split it or justify in the PR body')
} else {
  Add-Check 'parity-rows' 'PASS' ([string]$allRowIds.Count + ' parity row(s) declared')
}

# ---- e. zh-Hans coverage -----------------------------------------------------

$i18nPath = Join-Path $Worktree 'src\renderer\i18n.ts'
$i18nText = ''
if (Test-Path -LiteralPath $i18nPath -PathType Leaf) { $i18nText = Read-Utf8 $i18nPath }
$srcPlus = @($plusAll | Where-Object {
    $_.file -like 'src/*' -and $_.file -ne 'src/renderer/i18n.ts' -and ($_.file -like '*.ts' -or $_.file -like '*.tsx')
  })
$missing = New-Object 'System.Collections.Generic.List[string]'
$templated = New-Object 'System.Collections.Generic.List[string]'
$seen = New-Object 'System.Collections.Generic.HashSet[string]'
$noticePrefix = '(?:Hydra|Hydra settings|Sub-agents):'
foreach ($p in $srcPlus) {
  $keys = New-Object 'System.Collections.Generic.List[string]'
  foreach ($m in [regex]::Matches($p.text, '\bt\(\s*"((?:[^"\\]|\\.)*)"')) { $keys.Add($m.Groups[1].Value) }
  foreach ($m in [regex]::Matches($p.text, "\bt\(\s*'((?:[^'\\]|\\.)*)'")) { $keys.Add(($m.Groups[1].Value -replace "\\'", "'") -replace '(?<!\\)"', '\"') }
  if ($p.file -like 'src/main/*') {
    foreach ($m in [regex]::Matches($p.text, '"(' + $noticePrefix + '(?:[^"\\]|\\.)*)"')) { $keys.Add($m.Groups[1].Value) }
    foreach ($m in [regex]::Matches($p.text, '`(' + $noticePrefix + '[^`]*)`')) {
      $v = $m.Groups[1].Value
      if ($v.Contains('${')) { $templated.Add($p.file + ':' + $p.line) } else { $keys.Add($v -replace '(?<!\\)"', '\"') }
    }
  }
  foreach ($k in $keys) {
    if ([string]::IsNullOrEmpty($k) -or -not $seen.Add($k)) { continue }
    if (-not $i18nText.Contains('"' + $k + '":')) { $missing.Add('"' + $k + '" (' + $p.file + ':' + $p.line + ')') }
  }
}
if ($missing.Count -gt 0) {
  Add-Check 'zh-hans' 'FAIL' ('new user-visible strings without a zh-Hans entry in src/renderer/i18n.ts: ' + (Join-Limited $missing.ToArray()))
} else {
  Add-Check 'zh-hans' 'PASS' ([string]$seen.Count + ' new literal key(s) all have zh-Hans entries')
}
if ($templated.Count -gt 0) {
  Add-Check 'zh-hans-templates' 'WARN' ('templated notices (confirm a matching %@ key exists in i18n.ts and translateNotice recovers it): ' + (Join-Limited $templated.ToArray()))
}
$unprefixed = New-Object 'System.Collections.Generic.List[string]'
foreach ($p in @($srcPlus | Where-Object { $_.file -like 'src/main/*' -and $_.text -match '(?i)\bnotice|\bnote\s*:' })) {
  foreach ($m in [regex]::Matches($p.text, '["`]([A-Z][^"`]{8,})["`]')) {
    if ($m.Groups[1].Value -notmatch ('^' + $noticePrefix)) { $unprefixed.Add($p.file + ':' + $p.line) ; break }
  }
}
if ($unprefixed.Count -gt 0) {
  Add-Check 'notice-prefix' 'WARN' ('possible user notices without a Hydra: / Hydra settings: / Sub-agents: prefix; translateNotice will not localize them: ' + (Join-Limited $unprefixed.ToArray()))
}

# ---- f. license header -------------------------------------------------------

$headerExt = @('.ts', '.tsx', '.mjs', '.cjs', '.js', '.css', '.ps1', '.cmd')
$noHeader = New-Object 'System.Collections.Generic.List[string]'
foreach ($f in @($addedSet | Sort-Object)) {
  if (-not (Test-UnderPrefix $f @('src/', 'scripts/', 'tests/'))) { continue }
  if ($headerExt -notcontains ([IO.Path]::GetExtension($f).ToLowerInvariant())) { continue }
  $full = Join-Path $Worktree $f
  if (-not (Test-Path -LiteralPath $full -PathType Leaf)) { continue }
  $head = @((Read-Utf8 $full) -split "`r?`n" | Select-Object -First 4) -join "`n"
  if (-not $head.Contains('derived from Tivano (AGPL-3.0)')) { $noHeader.Add($f) }
}
if ($noHeader.Count -gt 0) {
  Add-Check 'license-header' 'FAIL' ('new files without the two-line license header: ' + (Join-Limited $noHeader.ToArray()))
} else {
  Add-Check 'license-header' 'PASS' 'every new source file has the license header'
}

# ---- g. attribution ----------------------------------------------------------

$commitText = (@((Invoke-Git @('log', '--format=%B', ($mb + '..HEAD'))).lines) -join "`n")
$attr = New-Object 'System.Collections.Generic.List[string]'
$commitAttr = New-Object 'System.Collections.Generic.List[string]'
if ($commitText -match '(?im)^\s*co-authored-by:') { $commitAttr.Add('a branch commit has a Co-authored-by: line') }
if ($commitText -match '(?im)^\s*generated (with|by)\b') { $commitAttr.Add('a branch commit has a Generated with/by line') }
if ($commitAttr.Count -gt 0) {
  # Pushed commits are never rewritten; the watchdog squash-merges with its own message, so this cannot reach main.
  Add-Check 'commit-attribution' 'WARN' (($commitAttr.ToArray() -join '; ') + '; do not add it to new commits (the squash merge drops it)')
}
if ($BodyFile) {
  if ($bodyText -match '(?im)^\s*(?:[>*+-]\s*)?co-authored-by\s*:') { $attr.Add('the PR body has a Co-authored-by: line') }
  if ($bodyText -match '(?i)\bgenerated (with|by) \[') { $attr.Add('the PR body has a Generated with/by [..] footer') }
  if ($bodyText -match '(?i)devin-ai-integration') { $attr.Add('the PR body has a devin-ai-integration reference') }
}
if ($attr.Count -gt 0) {
  Add-Check 'attribution' 'FAIL' ('no AI attribution outside the template Coding agent use section: ' + ($attr.ToArray() -join '; '))
} else {
  Add-Check 'attribution' 'PASS' 'no attribution lines'
}

# ---- h. closes issue ---------------------------------------------------------

if ($BodyFile -and $Issue -gt 0) {
  if ($bodyText -match ('(?im)^\s*-?\s*Closes #' + $Issue + '\b')) {
    Add-Check 'closes-issue' 'PASS' ('body closes #' + $Issue)
  } else {
    Add-Check 'closes-issue' 'FAIL' ('PR body must contain a line "Closes #' + $Issue + '" under Related')
  }
} else {
  Add-Check 'closes-issue' 'SKIP' 'needs -BodyFile and -Issue'
}

# ---- i. stray and uncommitted files ------------------------------------------

$stray = New-Object 'System.Collections.Generic.List[string]'
$pending = New-Object 'System.Collections.Generic.List[string]'
foreach ($f in $untracked) {
  $isJunk = ($f -match '(?i)\.(log|tmp|bak|orig|rej)$') -or (Test-UnderPrefix $f @('dist/', '.devdata/', 'node_modules/'))
  if ($isJunk -or -not (Test-UnderPrefix $f @('src/', 'tests/', 'docs/', 'scripts/', 'config/'))) { $stray.Add($f) } else { $pending.Add($f + ' (untracked)') }
}
foreach ($f in $modifiedUncommitted) { $pending.Add($f + ' (uncommitted)') }
if ($stray.Count -gt 0) {
  Add-Check 'stray-files' 'FAIL' ('remove stray files from the worktree: ' + (Join-Limited $stray.ToArray()))
} else {
  Add-Check 'stray-files' 'PASS' 'no stray files'
}
if ($pending.Count -gt 0) {
  Add-Check 'uncommitted' 'WARN' ('commit or delete before push: ' + (Join-Limited $pending.ToArray()))
}

# ---- pr size (advisory) ------------------------------------------------------

$sizeLines = @($plusAll + $minusAll | Where-Object {
    $_.file -like 'src/*' -and $_.file -ne 'src/renderer/i18n.ts' -and $_.file -notlike 'src/renderer/locales/*'
  }).Count
if ($sizeLines -gt 600) {
  Add-Check 'pr-size' 'WARN' ([string]$sizeLines + ' changed lines in src/ (tests and translation catalogs excluded); keep a PR to about 600 - implement the smallest slice of the row and leave the rest partial for a follow-up')
} else {
  Add-Check 'pr-size' 'PASS' ([string]$sizeLines + ' changed lines in src/ (tests and translation catalogs excluded)')
}

# ---- j. UNC paths (advisory) -------------------------------------------------

$sync = @($plusAll | Where-Object { $_.file -like 'src/main/*' -and $_.text -match '\b(statSync|lstatSync|existsSync|realpathSync|readdirSync|accessSync|openSync)\s*\(' } |
    ForEach-Object { $_.file + ':' + $_.line })
if ($sync.Count -gt 0) {
  Add-Check 'unc-paths' 'WARN' ('new synchronous fs calls in the main process; paths from the renderer, model output or files may be UNC (\\host, //host, file://host) - never touch those synchronously: ' + (Join-Limited $sync))
}

# ---- k. OS-specific paths in tests (advisory) --------------------------------

$osHits = New-Object 'System.Collections.Generic.List[string]'
foreach ($f in @($changed | Where-Object { $_ -like 'tests/*' })) {
  $full = Join-Path $Worktree $f
  if (-not (Test-Path -LiteralPath $full -PathType Leaf)) { continue }
  $txt = Read-Utf8 $full
  if ($txt -notmatch 'from\s+["'']node:path["'']' -or $txt -match '\b(win32|posix)\b') { continue }
  $drive = @($plusAll | Where-Object { $_.file -eq $f -and $_.text -match '[A-Za-z]:(\\\\|/)' })
  if ($drive.Count -gt 0) { $osHits.Add($f) }
}
if ($osHits.Count -gt 0) {
  Add-Check 'os-paths' 'WARN' ('tests with drive-letter paths but no path.win32/path.posix; make them pass on any OS: ' + (Join-Limited $osHits.ToArray()))
}

# ---- l. e2e selectors (advisory) ---------------------------------------------

$removedValues = New-Object 'System.Collections.Generic.HashSet[string]'
foreach ($r in @($minusAll | Where-Object { $_.file -like 'src/renderer/*' })) {
  foreach ($m in [regex]::Matches($r.text, '\b(?:title|aria-label|className)="([^"]{3,})"')) { $null = $removedValues.Add($m.Groups[1].Value) }
}
$stillAdded = New-Object 'System.Collections.Generic.HashSet[string]'
foreach ($a in @($plusAll | Where-Object { $_.file -like 'src/renderer/*' })) {
  foreach ($m in [regex]::Matches($a.text, '\b(?:title|aria-label|className)="([^"]{3,})"')) { $null = $stillAdded.Add($m.Groups[1].Value) }
}
$e2eHits = New-Object 'System.Collections.Generic.List[string]'
if ($removedValues.Count -gt 0) {
  $checkFiles = @(Get-ChildItem -LiteralPath (Join-Path $Worktree 'scripts') -Filter '*.mjs' -File -ErrorAction SilentlyContinue)
  foreach ($v in $removedValues) {
    if ($stillAdded.Contains($v)) { continue }
    foreach ($cf in $checkFiles) {
      if ((Read-Utf8 $cf.FullName).Contains($v)) { $e2eHits.Add('"' + $v + '" in scripts/' + $cf.Name) }
    }
  }
}
if ($e2eHits.Count -gt 0) {
  Add-Check 'e2e-selectors' 'WARN' ('e2e checks still target removed UI text/selectors; update them in the same PR: ' + (Join-Limited $e2eHits.ToArray()))
}

# ---- m. typecheck and changed tests (optional) -------------------------------

$script:TmpDir = Join-Path $env:TEMP ('preprcheck-' + $PID)

function Invoke-Capped {
  param([string]$Exe, [string]$Arguments, [string]$Tag, [string]$Dir, [int]$Minutes = 20)
  [IO.Directory]::CreateDirectory($script:TmpDir) | Out-Null
  $out = Join-Path $script:TmpDir ($Tag + '.out.log')
  $err = Join-Path $script:TmpDir ($Tag + '.err.log')
  $p = Start-Process -FilePath $Exe -ArgumentList $Arguments -WorkingDirectory $Dir -NoNewWindow -PassThru `
    -RedirectStandardOutput $out -RedirectStandardError $err
  $null = $p.Handle
  $exitCode = 1
  try {
    if (-not $p.WaitForExit($Minutes * 60000)) {
      $oldEap = $ErrorActionPreference
      $ErrorActionPreference = 'Continue'
      try { & taskkill.exe /T /F /PID $p.Id 2>$null | Out-Null } finally { $ErrorActionPreference = $oldEap }
      $null = $p.WaitForExit(5000)
      return [pscustomobject]@{ code = 124; tail = 'timed out after ' + $Minutes + ' min' }
    }
    $p.WaitForExit()
    $exitCode = [int]$p.ExitCode
  } finally {
    try { $p.Dispose() } catch { }
  }
  $text = ''
  foreach ($x in @($out, $err)) { if (Test-Path -LiteralPath $x) { $text += (Read-Utf8 $x) + "`n" } }
  $text = [regex]::Replace($text, '\x1b\[[0-9;]*m', '')
  $tailLines = @($text -split "`r?`n" | Where-Object { $_.Trim() } | Select-Object -Last 25)
  return [pscustomobject]@{ code = $exitCode; tail = ($tailLines -join ' | ') }
}

function Invoke-VitestFiles {
  # Runs vitest on the given repo-relative test files in $Dir with capped workers and returns
  # @{ ok; code; tail; failures = [ @{ key; label } ] } where key = file > full test name.
  param([string]$Dir, [string[]]$Files, [string]$Tag)
  $jsonOut = Join-Path $script:TmpDir ($Tag + '.vitest.json')
  $argList = '"node_modules\vitest\vitest.mjs" run --maxWorkers=' + $MaxWorkers + ' --reporter=json "--outputFile.json=' + $jsonOut + '" ' + ((@($Files) | ForEach-Object { '"' + $_ + '"' }) -join ' ')
  $run = Invoke-Capped $script:NodeExe $argList $Tag $Dir
  $fails = New-Object 'System.Collections.Generic.List[object]'
  if (-not (Test-Path -LiteralPath $jsonOut -PathType Leaf)) {
    return [pscustomobject]@{ ok = $false; code = $run.code; tail = $run.tail; failures = $fails.ToArray() }
  }
  try {
    $vj = (Read-Utf8 $jsonOut) | ConvertFrom-Json
  } catch {
    return [pscustomobject]@{ ok = $false; code = $run.code; tail = $run.tail; failures = $fails.ToArray() }
  }
  foreach ($tr in @($vj.testResults)) {
    $rel = ([string]$tr.name).Replace('\', '/')
    $ix = $rel.IndexOf('/tests/')
    if ($ix -ge 0) { $rel = $rel.Substring($ix + 1) }
    $failedAsserts = @(@($tr.assertionResults) | Where-Object { $_.status -eq 'failed' })
    if ($failedAsserts.Count -eq 0 -and [string]$tr.status -eq 'failed') {
      $why = ([string]$tr.message -split "`n")[0]
      $fails.Add([pscustomobject]@{ key = $rel + ' > (file)'; label = $rel + ' (file failed to run: ' + $why + ')' })
    }
    foreach ($a in $failedAsserts) {
      $first = ((@($a.failureMessages) -join ' ') -split "`n")[0]
      if ($first.Length -gt 160) { $first = $first.Substring(0, 160) }
      $key = $rel + ' > ' + [string]$a.fullName
      $fails.Add([pscustomobject]@{ key = $key; label = $key + ': ' + $first })
    }
  }
  return [pscustomobject]@{ ok = $true; code = $run.code; tail = $run.tail; failures = $fails.ToArray() }
}

if ($RunChecks) {
  $nodeCmd = Get-Command node.exe -ErrorAction SilentlyContinue
  $npmCmd = Get-Command npm.cmd -ErrorAction SilentlyContinue
  $nodeModules = Join-Path $Worktree 'node_modules'
  if (-not (Test-Path -LiteralPath $nodeModules -PathType Container) -or -not $nodeCmd -or -not $npmCmd) {
    Add-Check 'typecheck' 'FAIL' 'node_modules, node.exe or npm.cmd missing; run npm ci first'
    Add-Check 'changed-tests' 'SKIP' 'node_modules missing'
  } else {
    $script:NodeExe = $nodeCmd.Source
    $baseTree = Join-Path $env:TEMP ('preprcheck-base-' + $PID)
    $baseAdded = $false
    try {
      $tc = Invoke-Capped $env:ComSpec '/d /c npm.cmd run typecheck' 'typecheck' $Worktree
      if ($tc.code -eq 0) { Add-Check 'typecheck' 'PASS' 'npm run typecheck exit 0' } else { Add-Check 'typecheck' 'FAIL' ('exit ' + $tc.code + ': ' + $tc.tail) }
      $tests = @($changed | Where-Object { $_ -like 'tests/*' -and $_ -match '\.test\.(ts|tsx|mjs|js)$' -and (Test-Path -LiteralPath (Join-Path $Worktree $_) -PathType Leaf) })
      if ($tests.Count -eq 0) {
        Add-Check 'changed-tests' 'SKIP' 'no changed test files'
      } else {
        $pr = Invoke-VitestFiles $Worktree $tests 'pr'
        if (-not $pr.ok) {
          Add-Check 'changed-tests' 'FAIL' ('vitest exit ' + $pr.code + ' and no readable vitest.json: ' + $pr.tail)
        } elseif (@($pr.failures).Count -eq 0) {
          if ($pr.code -eq 0) { Add-Check 'changed-tests' 'PASS' ([string]$tests.Count + ' changed test file(s) pass (maxWorkers=' + $MaxWorkers + ')') } else { Add-Check 'changed-tests' 'FAIL' ('vitest exit ' + $pr.code + ' with no failed test recorded: ' + $pr.tail) }
        } else {
          # Compare with the merge base: a failure that also happens there is a host baseline failure, not this change.
          $failedFiles = @(@($pr.failures) | ForEach-Object { ($_.key -split ' > ')[0] } | Sort-Object -Unique)
          $baseFiles = New-Object 'System.Collections.Generic.List[string]'
          foreach ($f in $failedFiles) {
            $exists = Invoke-Git @('cat-file', '-e', ($mb + ':' + $f))
            if ($exists.code -eq 0) { $baseFiles.Add($f) }
          }
          $baseKeys = New-Object 'System.Collections.Generic.HashSet[string]'
          $baseNote = ''
          if ($baseFiles.Count -gt 0) {
            $wtAdd = Invoke-Git @('worktree', 'add', '--detach', '--quiet', $baseTree, $mb)
            if ($wtAdd.code -eq 0) {
              $baseAdded = $true
              $null = & $env:ComSpec /d /c mklink /J (Join-Path $baseTree 'node_modules') $nodeModules
              $baseRun = Invoke-VitestFiles $baseTree $baseFiles.ToArray() 'base'
              if ($baseRun.ok) { foreach ($bf in @($baseRun.failures)) { $null = $baseKeys.Add($bf.key) } } else { $baseNote = ' (base rerun failed: ' + $baseRun.tail + ')' }
            } else {
              $baseNote = ' (could not create a base worktree)'
            }
          }
          $real = @(@($pr.failures) | Where-Object { -not $baseKeys.Contains($_.key) } | ForEach-Object { $_.label })
          $known = @(@($pr.failures) | Where-Object { $baseKeys.Contains($_.key) } | ForEach-Object { $_.label })
          if ($real.Count -gt 0) {
            Add-Check 'changed-tests' 'FAIL' ([string]$real.Count + ' test(s) fail here but not on the merge base' + $baseNote + ': ' + (Join-Limited $real 10))
          } else {
            Add-Check 'changed-tests' 'PASS' ([string]$tests.Count + ' changed test file(s): every failure also fails on the merge base')
          }
          if ($known.Count -gt 0) {
            Add-Check 'baseline-tests' 'WARN' ([string]$known.Count + ' test(s) also fail on the merge base on this host (not caused by this change): ' + (Join-Limited $known 5))
          }
        }
      }
    } finally {
      if ($baseAdded) {
        $junction = Join-Path $baseTree 'node_modules'
        if (Test-Path -LiteralPath $junction) { $null = & $env:ComSpec /d /c rmdir $junction }
        if (Test-Path -LiteralPath $junction) {
          # Never delete through the junction: that would remove the real node_modules.
          Write-Output ('[WARN] cleanup: could not remove the node_modules junction in ' + $baseTree + '; remove it with rmdir, then git worktree prune')
        } else {
          $null = Invoke-Git @('worktree', 'remove', '--force', $baseTree)
          if (Test-Path -LiteralPath $baseTree) { Remove-Item -LiteralPath $baseTree -Recurse -Force -ErrorAction SilentlyContinue }
          $null = Invoke-Git @('worktree', 'prune')
        }
      }
      if (Test-Path -LiteralPath $script:TmpDir) { Remove-Item -LiteralPath $script:TmpDir -Recurse -Force -ErrorAction SilentlyContinue }
    }
  }
} else {
  Add-Check 'typecheck' 'SKIP' 'pass -RunChecks'
  Add-Check 'changed-tests' 'SKIP' 'pass -RunChecks'
}

# ---- report ------------------------------------------------------------------

$all = $script:Checks.ToArray()
foreach ($c in $all) { Write-Output ('[' + $c.status + '] ' + $c.name + ': ' + $c.detail) }
$failed = @($all | Where-Object { $_.status -eq 'FAIL' })
$summary = [ordered]@{ passed = ($failed.Count -eq 0); base = $mb; checks = $all }
Write-Output (ConvertTo-Json -InputObject $summary -Depth 4 -Compress)
if ($failed.Count -gt 0) { exit 1 }
exit 0
