# Tivano Windows - derived from Tivano (AGPL-3.0), modified 2026-11-21.
# Droppy Code by Jordy Spruit (Droppy), https://getdroppycode.app
# Usage: .\Invoke-PostMergeAudit.ps1 [-ConfigPath <path>] [-SinceHours 26] [-PrNumbers 94,95,...] [-DryRun]
# Audits merged nyx/* PRs on main after merge, opens/reopens issues for blocking findings, and self-heals main ruleset integrity.

param(
  [string]$ConfigPath = 'C:\tivano\audit\config.json',
  [ValidateRange(1, 8760)][int]$SinceHours = 26,
  [int[]]$PrNumbers = @(),
  [switch]$DryRun
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$script:GitPath = $null
$script:GhPath = $null
$script:CmdExe = Join-Path ([Environment]::GetFolderPath('System')) 'cmd.exe'
$script:LogPath = $null
$script:WorkRoot = $null
$script:Redactions = @()

function Get-Prop {
  param($Object, [string]$Name)
  if ($null -eq $Object) { return $null }
  if ($Object -is [System.Collections.IDictionary]) {
    if ($Object.Contains($Name)) { return $Object[$Name] }
    return $null
  }
  $prop = $Object.PSObject.Properties[$Name]
  if ($null -ne $prop) { return $prop.Value }
  return $null
}

function Write-TextUtf8 {
  param([string]$Path, [AllowEmptyString()][string]$Text)
  $parent = Split-Path -Parent $Path
  if ($parent -and -not (Test-Path -LiteralPath $parent -PathType Container)) {
    [IO.Directory]::CreateDirectory($parent) | Out-Null
  }
  [IO.File]::WriteAllText($Path, $Text, (New-Object Text.UTF8Encoding($false)))
}

function Write-TextAtomic {
  param([string]$Path, [AllowEmptyString()][string]$Text)
  $parent = Split-Path -Parent $Path
  if ($parent -and -not (Test-Path -LiteralPath $parent -PathType Container)) {
    [IO.Directory]::CreateDirectory($parent) | Out-Null
  }
  $tmp = $Path + '.tmp.' + [Guid]::NewGuid().ToString('N').Substring(0, 8)
  [IO.File]::WriteAllText($tmp, $Text, (New-Object Text.UTF8Encoding($false)))
  if (Test-Path -LiteralPath $Path -PathType Leaf) {
    [IO.File]::Replace($tmp, $Path, $null)
  } else {
    [IO.File]::Move($tmp, $Path)
  }
}

function Read-TextUtf8 {
  param([string]$Path)
  if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { return $null }
  return [IO.File]::ReadAllText($Path, [Text.Encoding]::UTF8)
}

function Write-AuditLog {
  param([string]$Message)
  $line = [DateTime]::Now.ToString('yyyy-MM-ddTHH:mm:ss') + ' ' + $Message
  if ($script:LogPath) {
    try {
      [IO.File]::AppendAllText($script:LogPath, ($line + "`r`n"), (New-Object Text.UTF8Encoding($false)))
    } catch { }
  }
}

function Quote-Arg {
  param([AllowEmptyString()][string]$Value)
  return '"' + $Value + '"'
}

function ConvertTo-SingleLine {
  param([AllowEmptyString()][string]$Text, [int]$Limit = 240)
  if ($null -eq $Text) { return '' }
  $line = [regex]::Replace($Text, '[\x00-\x1f\x7f]+', ' ')
  $line = [regex]::Replace($line, '\s+', ' ').Trim()
  if ($line.Length -gt $Limit) { $line = $line.Substring(0, $Limit).Trim() }
  return $line
}

function Initialize-Redactions {
  param($Config, [string[]]$ExtraPaths)
  $candidates = @()
  foreach ($key in @('workRoot', 'referenceRoot', 'keyPath', 'zcode')) {
    $val = [string](Get-Prop $Config $key)
    if ($val) { $candidates += $val }
  }
  $candidates += @($env:USERPROFILE, 'C:\tivano') + @($ExtraPaths)
  $all = @()
  foreach ($item in $candidates) {
    if ([string]::IsNullOrWhiteSpace($item) -or $item.Length -lt 4) { continue }
    $all += $item
    $all += $item.Replace('\', '/')
  }
  if ($env:COMPUTERNAME -and $env:COMPUTERNAME.Length -ge 4) { $all += $env:COMPUTERNAME }
  if ($env:USERNAME -and $env:USERNAME.Length -ge 4) { $all += $env:USERNAME }
  $script:Redactions = @($all | Sort-Object -Unique | Sort-Object { $_.Length } -Descending)
}

function Protect-PublicText {
  param([AllowEmptyString()][string]$Text)
  if ([string]::IsNullOrEmpty($Text)) { return '' }
  $result = $Text
  foreach ($secret in $script:Redactions) {
    $result = [regex]::Replace($result, [regex]::Escape($secret), '<redacted>', [Text.RegularExpressions.RegexOptions]::IgnoreCase)
  }
  $result = [regex]::Replace($result, '(?i)(?<![A-Za-z0-9])[A-Za-z]:(?:\\|/)[^\s"''`<>|\)\]]+', '<redacted-path>')
  $result = [regex]::Replace($result, '(?i)(?:\\|/)Users(?:\\|/)[^\\/\s"''`<>|\)\]]+', '<redacted-user>')
  return $result
}

function Invoke-ProcessCapture {
  param([string]$FilePath, [string]$Arguments, [string]$OutPath, [string]$ErrPath, [string]$WorkingDirectory)
  $params = @{
    FilePath = $FilePath
    ArgumentList = $Arguments
    RedirectStandardOutput = $OutPath
    RedirectStandardError = $ErrPath
    WindowStyle = 'Hidden'
    Wait = $true
    PassThru = $true
  }
  if ($WorkingDirectory) { $params['WorkingDirectory'] = $WorkingDirectory }
  $proc = Start-Process @params
  return $proc.ExitCode
}

function Test-GitNetworkFailure {
  param([string]$Text)
  if ([string]::IsNullOrWhiteSpace($Text)) { return $false }
  return ($Text -match '(?i)\bEOF\b|handshake|schannel|Could not resolve host|Failed to connect|connection (was )?(reset|refused|closed)|i/o timeout|TLS|unable to access|error connecting to|no such host')
}

function Invoke-GitCmd {
  param([string]$Directory, [string]$Arguments, [string]$TempBase)
  $out = Join-Path $TempBase '.git.out.tmp'
  $err = Join-Path $TempBase '.git.err.tmp'
  $fullArgs = if ($Directory) { '-C ' + (Quote-Arg $Directory) + ' ' + $Arguments } else { $Arguments }
  for ($try = 1; ; $try++) {
    $code = Invoke-ProcessCapture $script:GitPath $fullArgs $out $err $script:WorkRoot
    $res = [pscustomobject]@{
      exitCode = $code
      text = (Read-TextUtf8 $out)
      error = (Read-TextUtf8 $err)
    }
    if ($code -eq 0 -or $try -ge 4 -or -not (Test-GitNetworkFailure $res.error)) {
      return $res
    }
    Write-AuditLog ('git network failure, retry ' + $try + '/3: ' + (ConvertTo-SingleLine $res.error 160))
    Start-Sleep -Seconds (20 * $try)
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

function Test-PrStateDone {
  param([string]$StatePath)
  if (-not (Test-Path -LiteralPath $StatePath -PathType Leaf)) { return $false }
  try {
    $raw = Read-TextUtf8 $StatePath
    if ([string]::IsNullOrWhiteSpace($raw)) { return $false }
    $obj = $raw | ConvertFrom-Json
    return (([string](Get-Prop $obj 'status')).ToLowerInvariant() -eq 'done')
  } catch {
    return $false
  }
}

function Get-LinkedIssueNumber {
  param([string]$PrBody, [string]$HeadBranch)
  if (-not [string]::IsNullOrWhiteSpace($PrBody)) {
    $m = [regex]::Match($PrBody, '(?i)\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\s+#([0-9]+)\b')
    if ($m.Success) { return [int]$m.Groups[1].Value }
  }
  if (-not [string]::IsNullOrWhiteSpace($HeadBranch) -and $HeadBranch -match '^nyx/([0-9]+)-') {
    return [int]$Matches[1]
  }
  return 0
}

function Get-FollowupId {
  param($Followup, [int]$Index)
  $rawId = [string](Get-Prop $Followup 'id')
  if (-not [string]::IsNullOrWhiteSpace($rawId)) {
    $clean = [regex]::Replace($rawId.Trim().ToLowerInvariant(), '[^a-z0-9_-]+', '-').Trim('-')
    if ($clean.Length -gt 48) { $clean = $clean.Substring(0, 48).Trim('-') }
    if (-not [string]::IsNullOrWhiteSpace($clean)) { return $clean }
  }
  $title = [string](Get-Prop $Followup 'title')
  if ([string]::IsNullOrWhiteSpace($title)) { return ('f-' + $Index) }
  $norm = [regex]::Replace($title.Trim().ToLowerInvariant(), '\s+', ' ')
  $sha = [Security.Cryptography.SHA256]::Create()
  try {
    $bytes = [Text.Encoding]::UTF8.GetBytes($norm)
    $hashBytes = $sha.ComputeHash($bytes)
    $hex = -join ($hashBytes[0..3] | ForEach-Object { $_.ToString('x2') })
  } finally {
    $sha.Dispose()
  }
  $slug = [regex]::Replace($norm, '[^a-z0-9]+', '-').Trim('-')
  if ($slug.Length -gt 24) { $slug = $slug.Substring(0, 24).Trim('-') }
  if ([string]::IsNullOrWhiteSpace($slug)) { return ('f-' + $hex) }
  return ($slug + '-' + $hex)
}

function Normalize-Finding {
  param($Item, [string]$DefaultPrefix, [int]$Index)
  if ($null -eq $Item) { return $null }
  if ($Item -is [string]) {
    $text = $Item.Trim()
    if (-not $text) { return $null }
    return [pscustomobject]@{
      id = ($DefaultPrefix + '-' + $Index)
      severity = 'blocking'
      title = $text
      evidence = ''
      why = $text
    }
  }
  $id = [string](Get-Prop $Item 'id')
  if ([string]::IsNullOrWhiteSpace($id)) { $id = $DefaultPrefix + '-' + $Index }
  $sev = ([string](Get-Prop $Item 'severity')).Trim().ToLowerInvariant()
  if ($sev -ne 'blocking' -and $sev -ne 'advisory') { $sev = 'blocking' }
  $title = [string](Get-Prop $Item 'title')
  if ([string]::IsNullOrWhiteSpace($title)) { $title = [string](Get-Prop $Item 'message') }
  if ([string]::IsNullOrWhiteSpace($title)) { $title = $id }
  return [pscustomobject]@{
    id = $id.Trim()
    severity = $sev
    title = $title.Trim()
    evidence = ([string](Get-Prop $Item 'evidence')).Trim()
    why = ([string](Get-Prop $Item 'why')).Trim()
  }
}

function Find-ExistingIssueByMarker {
  param($Config, [string]$Repo, [string]$Marker)
  $tokenText = $Marker.Replace('<!--', '').Replace('-->', '').Trim()
  $query = 'repo:' + $Repo + ' is:issue "' + $tokenText + '" in:body'
  $path = '/search/issues?q=' + [Uri]::EscapeDataString($query) + '&per_page=20'
  $searchRes = Invoke-AuditApi -Config $Config -Method 'GET' -Path $path
  $items = Get-Prop $searchRes 'items'
  if ($null -eq $items) { return $null }
  foreach ($item in @($items)) {
    $body = [string](Get-Prop $item 'body')
    if ($body -and $body.IndexOf($Marker, [StringComparison]::Ordinal) -ge 0) {
      return $item
    }
  }
  return $null
}

function Ensure-AuditRepoClone {
  param([string]$Repo, [string]$RepoDir)
  $url = 'https://github.com/' + $Repo + '.git'
  if (-not (Test-Path -LiteralPath (Join-Path $RepoDir '.git'))) {
    Write-AuditLog ('cloning ' + $Repo + ' into ' + $RepoDir)
    if ((Test-Path -LiteralPath $RepoDir) -and @(Get-ChildItem -LiteralPath $RepoDir -Force -ErrorAction SilentlyContinue).Count -gt 0) {
      throw ('refusing to clone into non-empty directory without .git: ' + $RepoDir)
    }
    $cloneRes = Invoke-GitCmd '' ('clone --no-checkout ' + (Quote-Arg $url) + ' ' + (Quote-Arg $RepoDir)) $script:WorkRoot
    if ($cloneRes.exitCode -ne 0) {
      throw ('git clone failed: ' + (ConvertTo-SingleLine $cloneRes.error 240))
    }
  }
  $fetchRes = Invoke-GitCmd $RepoDir 'fetch --no-tags origin main' $script:WorkRoot
  if ($fetchRes.exitCode -ne 0) {
    throw ('git fetch origin main failed: ' + (ConvertTo-SingleLine $fetchRes.error 240))
  }
}

function Select-TargetPullRequests {
  param($Config, [string]$Repo, [int]$Hours, [int[]]$ExplicitNumbers, [string]$StateDir)
  $selected = New-Object Collections.Generic.List[object]
  $seen = @{}

  if ($ExplicitNumbers -and $ExplicitNumbers.Count -gt 0) {
    foreach ($num in $ExplicitNumbers) {
      if ($num -le 0 -or $seen.ContainsKey($num)) { continue }
      $seen[$num] = $true
      $statePath = Join-Path $StateDir ('post-' + $num + '.json')
      if (Test-PrStateDone $statePath) {
        Write-AuditLog ('skip PR #' + $num + ' (already done)')
        continue
      }
      $pr = Invoke-AuditApi -Config $Config -Method 'GET' -Path ('/repos/' + $Repo + '/pulls/' + $num)
      $mergedAt = [string](Get-Prop $pr 'merged_at')
      $mergeSha = [string](Get-Prop $pr 'merge_commit_sha')
      if ([string]::IsNullOrWhiteSpace($mergedAt) -or [string]::IsNullOrWhiteSpace($mergeSha)) {
        Write-AuditLog ('skip PR #' + $num + ' (not merged or missing merge_commit_sha)')
        continue
      }
      $null = $selected.Add($pr)
    }
    return $selected.ToArray()
  }

  $cutoffUtc = [DateTime]::UtcNow.AddHours(-$Hours)
  $candidates = New-Object Collections.Generic.List[object]
  for ($page = 1; $page -le 10; $page++) {
    $path = '/repos/' + $Repo + '/pulls?state=closed&base=main&sort=updated&direction=desc&per_page=100&page=' + $page
    $batch = Invoke-AuditApi -Config $Config -Method 'GET' -Path $path
    $items = @($batch | Where-Object { $null -ne $_ })
    if ($items.Count -eq 0) { break }

    $oldestUpdatedUtc = $null
    foreach ($pr in $items) {
      $updatedRaw = [string](Get-Prop $pr 'updated_at')
      if ($updatedRaw) {
        $uDt = [DateTimeOffset]::Parse($updatedRaw).UtcDateTime
        if ($null -eq $oldestUpdatedUtc -or $uDt -lt $oldestUpdatedUtc) { $oldestUpdatedUtc = $uDt }
      }
      $mergedRaw = [string](Get-Prop $pr 'merged_at')
      if ([string]::IsNullOrWhiteSpace($mergedRaw)) { continue }
      $mergedUtc = [DateTimeOffset]::Parse($mergedRaw).UtcDateTime
      if ($mergedUtc -lt $cutoffUtc) { continue }

      $baseObj = Get-Prop $pr 'base'
      $headObj = Get-Prop $pr 'head'
      $baseRef = [string](Get-Prop $baseObj 'ref')
      $headRef = [string](Get-Prop $headObj 'ref')
      $mergeSha = [string](Get-Prop $pr 'merge_commit_sha')
      $num = [int](Get-Prop $pr 'number')

      if ($baseRef -ne 'main') { continue }
      if ($headRef -notlike 'nyx/*') { continue }
      if ([string]::IsNullOrWhiteSpace($mergeSha)) { continue }
      if ($seen.ContainsKey($num)) { continue }
      $seen[$num] = $true

      $statePath = Join-Path $StateDir ('post-' + $num + '.json')
      if (Test-PrStateDone $statePath) {
        Write-AuditLog ('skip PR #' + $num + ' (already done)')
        continue
      }
      $null = $candidates.Add($pr)
    }

    if ($items.Count -lt 100) { break }
    if ($null -ne $oldestUpdatedUtc -and $oldestUpdatedUtc -lt $cutoffUtc) { break }
  }

  return @($candidates | Sort-Object { [int](Get-Prop $_ 'number') })
}

function Build-IssueBlockComment {
  param([int]$PrNumber, [string]$ShortSha, $BlockingFindings, $FailedAcceptance, $FalseClaims, [string]$Marker)
  $lines = New-Object Collections.Generic.List[string]
  $null = $lines.Add('> Automated post-merge audit (`nyx/audit`) for merged PR #' + $PrNumber + ' (`' + $ShortSha + '`). Independent audit; not a maintainer decision.')
  $null = $lines.Add('')
  $null = $lines.Add('Post-merge audit verdict: **block**.')
  $null = $lines.Add('')
  $null = $lines.Add('### Blocking findings')
  if (-not $BlockingFindings -or @($BlockingFindings).Count -eq 0) {
    $null = $lines.Add('- See acceptance/claim details below.')
  } else {
    foreach ($f in @($BlockingFindings)) {
      $ev = if ($f.evidence) { ' (' + (Protect-PublicText $f.evidence) + ')' } else { '' }
      $why = if ($f.why) { ' -- ' + (Protect-PublicText $f.why) } else { '' }
      $null = $lines.Add('- `[' + (Protect-PublicText $f.id) + ']` **' + (Protect-PublicText $f.title) + '**' + $ev + $why)
    }
  }
  if ($FailedAcceptance -and @($FailedAcceptance).Count -gt 0) {
    $null = $lines.Add('')
    $null = $lines.Add('### Incomplete or substituted acceptance criteria')
    foreach ($a in @($FailedAcceptance)) {
      $aItem = Protect-PublicText ([string](Get-Prop $a 'item'))
      $aStatus = Protect-PublicText ([string](Get-Prop $a 'status'))
      $aEv = Protect-PublicText ([string](Get-Prop $a 'evidence'))
      $null = $lines.Add('- **' + $aStatus + '**: ' + $aItem + $(if ($aEv) { ' (' + $aEv + ')' } else { '' }))
    }
  }
  if ($FalseClaims -and @($FalseClaims).Count -gt 0) {
    $null = $lines.Add('')
    $null = $lines.Add('### Unverified or false PR-body claims')
    foreach ($c in @($FalseClaims)) {
      $cClaim = Protect-PublicText ([string](Get-Prop $c 'claim'))
      $cEv = Protect-PublicText ([string](Get-Prop $c 'evidence'))
      $null = $lines.Add('- ' + $cClaim + $(if ($cEv) { ' (' + $cEv + ')' } else { '' }))
    }
  }
  $null = $lines.Add('')
  $null = $lines.Add($Marker)
  return (Protect-PublicText (($lines -join "`n") + "`n"))
}

function Ensure-AuditLogLabel {
  param($Config, [string]$Repo)
  $exists = $false
  try {
    $null = Invoke-AuditApi -Config $Config -Method 'GET' -Path ('/repos/' + $Repo + '/labels/audit-log')
    $exists = $true
  } catch {
    $exists = $false
  }
  if (-not $exists) {
    try {
      $null = Invoke-AuditApi -Config $Config -Method 'POST' -Path ('/repos/' + $Repo + '/labels') -Body @{
        name = 'audit-log'
        color = '0052cc'
        description = 'Append-only automated audit event log'
      }
    } catch {
      Write-AuditLog ('create audit-log label note: ' + (ConvertTo-SingleLine $_.Exception.Message 160))
    }
  }
}

function Add-AuditLogComment {
  param(
    $Config,
    [string]$Repo,
    [string]$CommentBody,
    [switch]$IsDryRun
  )
  $logTitle = 'Audit log'
  if ($IsDryRun) {
    Write-AuditLog ('dry-run: would append comment to "' + $logTitle + '" issue (label audit-log)')
    return
  }

  Ensure-AuditLogLabel -Config $Config -Repo $Repo

  $existing = $null
  try {
    $labelled = Invoke-AuditApi -Config $Config -Method 'GET' -Path ('/repos/' + $Repo + '/issues?state=open&labels=audit-log&per_page=100')
    foreach ($iss in @($labelled)) {
      if ($null -eq $iss) { continue }
      if ($null -ne (Get-Prop $iss 'pull_request')) { continue }
      if (([string](Get-Prop $iss 'title')).Trim() -eq $logTitle) {
        $existing = $iss
        break
      }
    }
  } catch {
    Write-AuditLog ('warning: failed to list open audit-log issues: ' + (ConvertTo-SingleLine $_.Exception.Message 160))
  }

  if ($null -eq $existing) {
    try {
      $query = 'repo:' + $Repo + ' is:issue "' + $logTitle + '" in:title'
      $searchPath = '/search/issues?q=' + [Uri]::EscapeDataString($query) + '&per_page=50'
      $searchRes = Invoke-AuditApi -Config $Config -Method 'GET' -Path $searchPath
      $items = Get-Prop $searchRes 'items'
      $closedMatch = $null
      if ($null -ne $items) {
        foreach ($iss in @($items)) {
          if ($null -eq $iss) { continue }
          if ($null -ne (Get-Prop $iss 'pull_request')) { continue }
          if (([string](Get-Prop $iss 'title')).Trim() -ne $logTitle) { continue }
          $st = ([string](Get-Prop $iss 'state')).ToLowerInvariant()
          if ($st -eq 'open') {
            $existing = $iss
            break
          } elseif ($null -eq $closedMatch) {
            $closedMatch = $iss
          }
        }
      }
      if ($null -eq $existing -and $null -ne $closedMatch) {
        $existing = $closedMatch
      }
    } catch {
      Write-AuditLog ('warning: failed to search Audit log issue by title: ' + (ConvertTo-SingleLine $_.Exception.Message 160))
    }
  }

  $issueNum = 0
  if ($null -ne $existing) {
    $issueNum = [int](Get-Prop $existing 'number')
    $existingState = ([string](Get-Prop $existing 'state')).ToLowerInvariant()
    if ($existingState -eq 'closed') {
      try {
        $null = Invoke-AuditApi -Config $Config -Method 'PATCH' -Path ('/repos/' + $Repo + '/issues/' + $issueNum) -Body @{ state = 'open' }
        Write-AuditLog ('reopened Audit log issue #' + $issueNum)
      } catch {
        Write-AuditLog ('warning: failed to reopen Audit log issue #' + $issueNum + ': ' + (ConvertTo-SingleLine $_.Exception.Message 160))
      }
    }
    try {
      $null = Invoke-AuditApi -Config $Config -Method 'POST' -Path ('/repos/' + $Repo + '/issues/' + $issueNum + '/labels') -Body @{ labels = @('audit-log') }
    } catch { }
  } else {
    $created = Invoke-AuditApi -Config $Config -Method 'POST' -Path ('/repos/' + $Repo + '/issues') -Body @{
      title = $logTitle
      body = "Automated append-only audit log for ``nyx/audit``. Events are appended as comments below.`n"
      labels = @('audit-log')
    }
    $issueNum = [int](Get-Prop $created 'number')
    Write-AuditLog ('created Audit log issue #' + $issueNum + ' (label audit-log, unassigned)')
  }

  $null = Invoke-AuditApi -Config $Config -Method 'POST' -Path ('/repos/' + $Repo + '/issues/' + $issueNum + '/comments') -Body @{
    body = $CommentBody
  }
  Write-AuditLog ('appended event comment to Audit log issue #' + $issueNum)
}

function Invoke-GhApi {
  param(
    [string]$Arguments,
    [string]$TempBase
  )
  if ([string]::IsNullOrWhiteSpace($script:GhPath)) {
    return [pscustomobject]@{
      exitCode = -1
      text = ''
      error = 'gh CLI was not found on PATH.'
    }
  }
  $out = Join-Path $TempBase '.gh.out.tmp'
  $err = Join-Path $TempBase '.gh.err.tmp'
  $code = Invoke-ProcessCapture $script:GhPath $Arguments $out $err $script:WorkRoot
  return [pscustomobject]@{
    exitCode = $code
    text = [string](Read-TextUtf8 $out)
    error = [string](Read-TextUtf8 $err)
  }
}

function Test-AuditRulesetIntegrity {
  param($Config, [string]$Repo, [switch]$IsDryRun)
  $statusContext = [string](Get-Prop $Config 'statusContext')
  if ([string]::IsNullOrWhiteSpace($statusContext)) { $statusContext = 'nyx/audit' }
  $expectedAppId = [long](Get-Prop $Config 'appId')
  $targetRulesetName = 'nyx audit'

  $defaultBranch = 'main'
  try {
    $repoInfo = Invoke-AuditApi -Config $Config -Method 'GET' -Path ('/repos/' + $Repo)
    $db = [string](Get-Prop $repoInfo 'default_branch')
    if (-not [string]::IsNullOrWhiteSpace($db)) { $defaultBranch = $db }
  } catch {
    Write-AuditLog ('warning: could not read default_branch, assuming main: ' + (ConvertTo-SingleLine $_.Exception.Message 160))
  }

  $foundValid = $false
  $matchedInfo = ''
  $nyxRulesetId = $null
  $appListFailed = $false
  $inspectionNotes = New-Object Collections.Generic.List[string]

  try {
    $listRes = Invoke-AuditApi -Config $Config -Method 'GET' -Path ('/repos/' + $Repo + '/rulesets')
    $summaries = @($listRes | Where-Object { $null -ne $_ })
    if ($summaries.Count -eq 0) {
      $null = $inspectionNotes.Add('No repository rulesets returned by GET /repos/' + $Repo + '/rulesets.')
    }
    foreach ($summary in $summaries) {
      $rsId = Get-Prop $summary 'id'
      if ($null -eq $rsId) { continue }
      $detail = Invoke-AuditApi -Config $Config -Method 'GET' -Path ('/repos/' + $Repo + '/rulesets/' + $rsId)
      $rsName = [string](Get-Prop $detail 'name')
      if ($null -eq $nyxRulesetId -and $rsName.Trim().Equals($targetRulesetName, [StringComparison]::OrdinalIgnoreCase)) {
        $nyxRulesetId = [long]$rsId
      }
      $enforcement = ([string](Get-Prop $detail 'enforcement')).ToLowerInvariant()
      $target = ([string](Get-Prop $detail 'target')).ToLowerInvariant()

      $conditions = Get-Prop $detail 'conditions'
      $refName = Get-Prop $conditions 'ref_name'
      $includes = @(Get-Prop $refName 'include' | ForEach-Object { [string]$_ } | Where-Object { $_ })
      $excludes = @(Get-Prop $refName 'exclude' | ForEach-Object { [string]$_ } | Where-Object { $_ })

      $targetsDefault = (
        ($includes -contains '~DEFAULT_BRANCH') -or
        ($includes -contains '~ALL') -or
        ($includes -contains ('refs/heads/' + $defaultBranch))
      ) -and -not (
        ($excludes -contains '~DEFAULT_BRANCH') -or
        ($excludes -contains ('refs/heads/' + $defaultBranch))
      )

      $hasMatchingCheck = $false
      $rules = @(Get-Prop $detail 'rules' | Where-Object { $null -ne $_ })
      foreach ($rule in $rules) {
        if (([string](Get-Prop $rule 'type')).ToLowerInvariant() -ne 'required_status_checks') { continue }
        $paramsObj = Get-Prop $rule 'parameters'
        $checks = @(Get-Prop $paramsObj 'required_status_checks' | Where-Object { $null -ne $_ })
        foreach ($chk in $checks) {
          $ctx = [string](Get-Prop $chk 'context')
          $intIdRaw = Get-Prop $chk 'integration_id'
          $intId = if ($null -ne $intIdRaw -and "$intIdRaw" -match '^[0-9]+$') { [long]$intIdRaw } else { -1 }
          if ($ctx -eq $statusContext -and $intId -eq $expectedAppId) {
            $hasMatchingCheck = $true
            break
          }
        }
        if ($hasMatchingCheck) { break }
      }

      if ($enforcement -eq 'active' -and $target -eq 'branch' -and $targetsDefault -and $hasMatchingCheck) {
        $foundValid = $true
        $matchedInfo = 'id=' + $rsId + ' name=' + $rsName
        break
      } else {
        $null = $inspectionNotes.Add('Ruleset #' + $rsId + ' (' + $rsName + '): enforcement=' + $enforcement + ', target=' + $target + ', targetsDefault=' + $targetsDefault + ', hasContextAndApp=' + $hasMatchingCheck)
      }
    }
  } catch {
    $appListFailed = $true
    $errMsg = ConvertTo-SingleLine $_.Exception.Message 200
    $null = $inspectionNotes.Add('Ruleset API check failed: ' + (Protect-PublicText $errMsg))
    Write-AuditLog ('ruleset integrity API error: ' + $errMsg)
  }

  if ($foundValid) {
    Write-AuditLog ('ruleset integrity OK: ' + $matchedInfo)
    return $true
  }

  Write-AuditLog ('ruleset integrity FAILED: no active default-branch ruleset requires ' + $statusContext + ' from appId=' + $expectedAppId + '; attempting self-heal via gh CLI')

  # If the App-token GET failed, check via gh CLI before deciding PUT vs POST to avoid duplicates.
  if ($appListFailed -and $null -eq $nyxRulesetId -and -not [string]::IsNullOrWhiteSpace($script:GhPath)) {
    $ghList = Invoke-GhApi -Arguments ('api repos/' + $Repo + '/rulesets') -TempBase $script:WorkRoot
    if ($ghList.exitCode -eq 0 -and -not [string]::IsNullOrWhiteSpace($ghList.text)) {
      try {
        $ghSummaries = @(($ghList.text | ConvertFrom-Json) | ForEach-Object { $_ } | Where-Object { $null -ne $_ })
        foreach ($s in $ghSummaries) {
          $sName = [string](Get-Prop $s 'name')
          $sId = Get-Prop $s 'id'
          if ($null -ne $sId -and $sName.Trim().Equals($targetRulesetName, [StringComparison]::OrdinalIgnoreCase)) {
            $nyxRulesetId = [long]$sId
            break
          }
        }
      } catch { }
    }
  }

  $rulesetPayload = [ordered]@{
    name = $targetRulesetName
    target = 'branch'
    enforcement = 'active'
    bypass_actors = @()
    conditions = [ordered]@{
      ref_name = [ordered]@{
        include = @('~DEFAULT_BRANCH')
        exclude = @()
      }
    }
    rules = @(
      [ordered]@{
        type = 'required_status_checks'
        parameters = [ordered]@{
          strict_required_status_checks_policy = $false
          required_status_checks = @(
            [ordered]@{
              context = $statusContext
              integration_id = $expectedAppId
            }
          )
        }
      }
    )
  }

  $healMethod = 'POST'
  $healEndpoint = 'repos/' + $Repo + '/rulesets'
  if ($null -ne $nyxRulesetId) {
    $healMethod = 'PUT'
    $healEndpoint = 'repos/' + $Repo + '/rulesets/' + $nyxRulesetId
  }

  $healed = $false
  $healDetail = ''
  if ($IsDryRun) {
    $healDetail = 'dry-run: would run gh api -X ' + $healMethod + ' ' + $healEndpoint + ' (enforcement=active, context=' + $statusContext + ', integration_id=' + $expectedAppId + ')'
    Write-AuditLog $healDetail
  } else {
    $payloadPath = Join-Path $script:WorkRoot '.ruleset-heal.json'
    try {
      Write-TextUtf8 $payloadPath ((ConvertTo-Json -InputObject $rulesetPayload -Depth 10 -Compress) + "`n")
      $ghArgs = 'api -X ' + $healMethod + ' ' + $healEndpoint + ' --input ' + (Quote-Arg $payloadPath)
      $healRes = Invoke-GhApi -Arguments $ghArgs -TempBase $script:WorkRoot
      if ($healRes.exitCode -eq 0) {
        $healed = $true
        $healedId = $nyxRulesetId
        if (-not [string]::IsNullOrWhiteSpace($healRes.text)) {
          try {
            $respObj = $healRes.text | ConvertFrom-Json
            $respId = Get-Prop $respObj 'id'
            if ($null -ne $respId) { $healedId = [long]$respId }
          } catch { }
        }
        $healDetail = 'Self-heal succeeded via gh api -X ' + $healMethod + ' ' + $healEndpoint + $(if ($null -ne $healedId) { ' (ruleset #' + $healedId + ')' } else { '' }) + '.'
        Write-AuditLog ('ruleset self-heal OK: ' + $healDetail)
      } else {
        $errSummary = ConvertTo-SingleLine $(if (-not [string]::IsNullOrWhiteSpace($healRes.error)) { $healRes.error } else { $healRes.text }) 220
        $healDetail = 'Self-heal failed via gh api -X ' + $healMethod + ' ' + $healEndpoint + ' (exit ' + $healRes.exitCode + '): ' + (Protect-PublicText $errSummary)
        Write-AuditLog ('ruleset self-heal FAILED: ' + $healDetail)
      }
    } finally {
      if (Test-Path -LiteralPath $payloadPath -PathType Leaf) {
        Remove-Item -LiteralPath $payloadPath -Force -ErrorAction SilentlyContinue
      }
    }
  }

  $checkedAt = [DateTime]::UtcNow.ToString('yyyy-MM-ddTHH:mm:ssZ')
  $bodyLines = New-Object Collections.Generic.List[string]
  $statusHeading = if ($healed) { 'Ruleset self-healed' } else { 'Ruleset self-heal failed' }
  $null = $bodyLines.Add('### ' + $statusHeading + ' (' + $checkedAt + ')')
  $null = $bodyLines.Add('')
  $null = $bodyLines.Add('Post-merge integrity check found no active branch ruleset on `' + $defaultBranch + '` enforcing required status check `' + $statusContext + '` from the audit GitHub App (`integration_id` = `' + $expectedAppId + '`).')
  $null = $bodyLines.Add('')
  $null = $bodyLines.Add('- Action: `' + $healMethod + ' ' + $healEndpoint + '` via owner `gh` CLI login')
  $null = $bodyLines.Add('- Result: ' + (Protect-PublicText $healDetail))
  if ($inspectionNotes.Count -gt 0) {
    $null = $bodyLines.Add('')
    $null = $bodyLines.Add('Inspected rulesets prior to heal:')
    foreach ($note in $inspectionNotes.ToArray()) {
      $null = $bodyLines.Add('- ' + (Protect-PublicText $note))
    }
  }
  $logBody = Protect-PublicText (($bodyLines.ToArray() -join "`n") + "`n")

  try {
    Add-AuditLogComment -Config $Config -Repo $Repo -CommentBody $logBody -IsDryRun:$IsDryRun
  } catch {
    Write-AuditLog ('warning: failed to append ruleset event to Audit log issue: ' + (ConvertTo-SingleLine $_.Exception.Message 180))
  }

  return $healed
}

$lockStream = $null
$summary = [ordered]@{
  ok = $false
  dryRun = [bool]$DryRun
  audited = @()
  skipped = @()
  unavailable = @()
  blocked = @()
  followupsCreated = @()
  rulesetOk = $false
  errors = @()
}

try {
  if ([Environment]::OSVersion.Platform -ne [PlatformID]::Win32NT) {
    throw 'Windows is required.'
  }

  $modulePath = Join-Path $PSScriptRoot 'AuditChecks.psm1'
  if (-not (Test-Path -LiteralPath $modulePath -PathType Leaf)) {
    throw ('AuditChecks.psm1 not found next to this script: ' + $modulePath)
  }
  Import-Module $modulePath -Force

  $promptTemplatePath = Join-Path $PSScriptRoot 'postmerge-prompt.md'
  if (-not (Test-Path -LiteralPath $promptTemplatePath -PathType Leaf)) {
    throw ('postmerge-prompt.md not found next to this script: ' + $promptTemplatePath)
  }
  $promptTemplate = Read-TextUtf8 $promptTemplatePath

  $config = Get-AuditConfig -Path $ConfigPath
  $repo = [string](Get-Prop $config 'repo')
  $workRoot = [string](Get-Prop $config 'workRoot')
  if ([string]::IsNullOrWhiteSpace($repo)) { throw 'Config missing repo.' }
  if ([string]::IsNullOrWhiteSpace($workRoot)) { throw 'Config missing workRoot.' }

  $script:WorkRoot = [IO.Path]::GetFullPath($workRoot).TrimEnd('\')
  $logsDir = Join-Path $script:WorkRoot 'logs'
  $stateDir = Join-Path $script:WorkRoot 'state'
  # Separate from the PR auditor's runs dir: each auditor prunes only its own runs.
  $runsDir = Join-Path $script:WorkRoot 'runs-post'
  $repoDir = Join-Path $script:WorkRoot 'repo'
  foreach ($d in @($script:WorkRoot, $logsDir, $stateDir, $runsDir)) {
    [IO.Directory]::CreateDirectory($d) | Out-Null
  }

  $script:LogPath = Join-Path $logsDir ('postmerge-' + [DateTime]::Now.ToString('yyyyMMdd') + '.log')
  Initialize-Redactions -Config $config -ExtraPaths @($script:WorkRoot, $ConfigPath)

  $lockPath = Join-Path $script:WorkRoot 'postmerge.lock'
  try {
    $lockStream = [IO.File]::Open($lockPath, [IO.FileMode]::OpenOrCreate, [IO.FileAccess]::ReadWrite, [IO.FileShare]::None)
  } catch {
    Write-AuditLog 'another post-merge audit run holds the lock; exiting cleanly'
    $summary.skipped = @('lock held by another run')
    $summary.ok = $true
    try { [Console]::OutputEncoding = New-Object Text.UTF8Encoding($false) } catch { }
    [Console]::Out.WriteLine((ConvertTo-Json -InputObject $summary -Depth 5 -Compress))
    exit 0
  }

  $env:GIT_TERMINAL_PROMPT = '0'
  $env:GCM_INTERACTIVE = 'never'
  $env:GH_PROMPT_DISABLED = '1'
  $env:GH_NO_UPDATE_NOTIFIER = '1'

  $gitCmd = Get-Command -Name 'git' -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
  if (-not $gitCmd) { throw 'git was not found on PATH.' }
  $script:GitPath = $gitCmd.Source

  $ghCmd = Get-Command -Name 'gh' -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($ghCmd) {
    $script:GhPath = $ghCmd.Source
  } else {
    Write-AuditLog 'warning: gh CLI was not found on PATH; ruleset self-heal will not be able to repair rulesets'
  }

  # Verify token minting succeeds up front so auth issues fail fast.
  $null = Get-AuditToken -Config $config

  Write-AuditLog ('start post-merge audit repo=' + $repo + ' sinceHours=' + $SinceHours + ' explicit=' + ($PrNumbers -join ',') + ' dryRun=' + [bool]$DryRun)

  # 1. Ruleset integrity check runs on every invocation.
  try {
    $summary.rulesetOk = Test-AuditRulesetIntegrity -Config $config -Repo $repo -IsDryRun:$DryRun
  } catch {
    $errLine = 'ruleset integrity error: ' + (ConvertTo-SingleLine $_.Exception.Message 200)
    Write-AuditLog $errLine
    $summary.errors += $errLine
  }

  # 2. Select merged nyx/* PRs to audit.
  $targetPrs = @(Select-TargetPullRequests -Config $config -Repo $repo -Hours $SinceHours -ExplicitNumbers $PrNumbers -StateDir $stateDir)
  # PRs left unaudited by an earlier run (unavailable or errored) are retried
  # regardless of the time window until their state file is done.
  $pendingPath = Join-Path $stateDir 'pending.json'
  $pendingPrs = @()
  if (Test-Path -LiteralPath $pendingPath -PathType Leaf) {
    try { $pendingPrs = @((Read-TextUtf8 $pendingPath) | ConvertFrom-Json | ForEach-Object { [int]$_ }) } catch { $pendingPrs = @() }
  }
  if (-not ($PrNumbers -and $PrNumbers.Count -gt 0)) {
    $selectedNums = @($targetPrs | ForEach-Object { [int](Get-Prop $_ 'number') })
    $retryNums = @($pendingPrs | Where-Object { $selectedNums -notcontains $_ })
    if ($retryNums.Count -gt 0) {
      $targetPrs = @($targetPrs) + @(Select-TargetPullRequests -Config $config -Repo $repo -Hours $SinceHours -ExplicitNumbers $retryNums -StateDir $stateDir)
    }
  }
  Write-AuditLog ('selected ' + $targetPrs.Count + ' PR(s) for post-merge audit')

  if ($targetPrs.Count -gt 0) {
    Ensure-AuditRepoClone -Repo $repo -RepoDir $repoDir
  }

  $refRoot = [string](Get-Prop $config 'referenceRoot')
  $extraReadDirs = @()
  if (-not [string]::IsNullOrWhiteSpace($refRoot) -and (Test-Path -LiteralPath $refRoot -PathType Container)) {
    $extraReadDirs = @($refRoot)
  }

  foreach ($pr in $targetPrs) {
    $prNum = [int](Get-Prop $pr 'number')
    $prTitle = [string](Get-Prop $pr 'title')
    $prBody = [string](Get-Prop $pr 'body')
    $headObj = Get-Prop $pr 'head'
    $headBranch = [string](Get-Prop $headObj 'ref')
    $mergeSha = [string](Get-Prop $pr 'merge_commit_sha')
    $shortSha = if ($mergeSha.Length -ge 7) { $mergeSha.Substring(0, 7) } else { $mergeSha }
    $stamp = [DateTime]::Now.ToString('yyyyMMddTHHmmss')
    $runDir = Join-Path $runsDir ('post-' + $prNum + '-' + $shortSha + '-' + $stamp)
    [IO.Directory]::CreateDirectory($runDir) | Out-Null

    $treeDir = Join-Path $runDir 'tree'
    $treeCreated = $false
    Write-AuditLog ('auditing PR #' + $prNum + ' merge=' + $shortSha + ' branch=' + $headBranch)

    try {
      $verifyCommit = Invoke-GitCmd $repoDir ('cat-file -e ' + $mergeSha + '^{commit}') $runDir
      if ($verifyCommit.exitCode -ne 0) {
        $fetchSha = Invoke-GitCmd $repoDir ('fetch --no-tags origin ' + $mergeSha) $runDir
        if ($fetchSha.exitCode -ne 0) {
          throw ('failed to fetch merge commit ' + $mergeSha + ': ' + (ConvertTo-SingleLine $fetchSha.error 180))
        }
      }

      $parentRes = Invoke-GitCmd $repoDir ('rev-parse --verify ' + $mergeSha + '^') $runDir
      if ($parentRes.exitCode -ne 0 -or [string]::IsNullOrWhiteSpace($parentRes.text)) {
        throw ('cannot resolve parent of merge commit ' + $mergeSha)
      }
      $parentSha = $parentRes.text.Trim()

      $treeCreated = $true
      $wtRes = Invoke-GitCmd $repoDir ('worktree add --detach ' + (Quote-Arg $treeDir) + ' ' + $mergeSha) $runDir
      if ($wtRes.exitCode -ne 0) {
        throw ('git worktree add failed: ' + (ConvertTo-SingleLine $wtRes.error 180))
      }

      $statRes = Invoke-GitCmd $repoDir ('diff --stat ' + $parentSha + '..' + $mergeSha) $runDir
      $diffStat = if ($statRes.exitCode -eq 0 -and $statRes.text) { $statRes.text.TrimEnd() } else { '(diff stat unavailable)' }

      $issueNumber = Get-LinkedIssueNumber -PrBody $prBody -HeadBranch $headBranch
      $issueObj = $null
      $issueBodyText = '(no linked issue found)'
      if ($issueNumber -gt 0) {
        try {
          $issueObj = Invoke-AuditApi -Config $config -Method 'GET' -Path ('/repos/' + $repo + '/issues/' + $issueNumber)
          $iTitle = [string](Get-Prop $issueObj 'title')
          $iState = [string](Get-Prop $issueObj 'state')
          $iBody = [string](Get-Prop $issueObj 'body')
          $issueBodyText = 'Title: ' + $iTitle + "`nState: " + $iState + "`n`n" + $(if ($iBody) { $iBody } else { '(empty)' })
        } catch {
          Write-AuditLog ('warning: could not load linked issue #' + $issueNumber + ': ' + (ConvertTo-SingleLine $_.Exception.Message 160))
          $issueBodyText = '(linked issue #' + $issueNumber + ' could not be loaded)'
        }
      }

      # Rule checks (guarded paths, test weakening) gate PRs before merge in Invoke-Audit.ps1;
      # the post-merge pass relies on the model audit alone.
      $detFindings = New-Object Collections.Generic.List[object]

      $promptText = $promptTemplate
      $promptText = $promptText.Replace('{{PR_NUMBER}}', [string]$prNum)
      $promptText = $promptText.Replace('{{PR_TITLE}}', $(if ($prTitle) { $prTitle } else { '' }))
      $promptText = $promptText.Replace('{{PR_BODY}}', $(if ($prBody) { $prBody } else { '(empty)' }))
      $promptText = $promptText.Replace('{{ISSUE_NUMBER}}', $(if ($issueNumber -gt 0) { [string]$issueNumber } else { 'none' }))
      $promptText = $promptText.Replace('{{ISSUE_BODY}}', $issueBodyText)
      $promptText = $promptText.Replace('{{DIFF_STAT}}', $diffStat)
      $promptText = $promptText.Replace('{{REFERENCE_ROOT}}', $(if ($extraReadDirs.Count -gt 0) { $extraReadDirs[0] } else { '(unavailable)' }))
      Write-TextUtf8 (Join-Path $runDir 'prompt.md') $promptText

      $modelParams = @{
        Config = $config
        PromptText = $promptText
        WorkDir = $treeDir
        RunDir = $runDir
      }
      if ($extraReadDirs.Count -gt 0) {
        $modelParams['ExtraReadDirs'] = $extraReadDirs
      }
      $modelRes = Invoke-AuditModel @modelParams
      $modelStatus = ([string](Get-Prop $modelRes 'status')).ToLowerInvariant()
      $modelResult = Get-Prop $modelRes 'result'
      $modelError = [string](Get-Prop $modelRes 'error')

      if ($modelStatus -ne 'ok' -or $null -eq $modelResult) {
        Write-AuditLog ('PR #' + $prNum + ' audit unavailable (will retry next run): ' + (ConvertTo-SingleLine $modelError 200))
        $summary.unavailable += $prNum
        continue
      }

      if ($modelResult -is [string]) {
        $modelResult = $modelResult | ConvertFrom-Json
      }

      $rawVerdict = ([string](Get-Prop $modelResult 'verdict')).Trim().ToLowerInvariant()
      if ($rawVerdict -ne 'pass' -and $rawVerdict -ne 'block') {
        Write-AuditLog ('PR #' + $prNum + ' invalid model verdict "' + $rawVerdict + '" (treating as unavailable, will retry)')
        $summary.unavailable += $prNum
        continue
      }

      $allFindings = New-Object Collections.Generic.List[object]
      $seenFindingIds = @{}
      foreach ($df in $detFindings) {
        if (-not $seenFindingIds.ContainsKey($df.id)) {
          $seenFindingIds[$df.id] = $true
          $null = $allFindings.Add($df)
        }
      }
      $mIdx = 0
      foreach ($mf in @(Get-Prop $modelResult 'findings')) {
        $mIdx++
        $norm = Normalize-Finding -Item $mf -DefaultPrefix 'audit' -Index $mIdx
        if ($null -ne $norm -and -not $seenFindingIds.ContainsKey($norm.id)) {
          $seenFindingIds[$norm.id] = $true
          $null = $allFindings.Add($norm)
        }
      }

      $blockingFindings = @($allFindings | Where-Object { $_.severity -eq 'blocking' })
      $acceptance = @(Get-Prop $modelResult 'acceptance' | Where-Object { $null -ne $_ })
      $failedAcceptance = @($acceptance | Where-Object {
        $st = ([string](Get-Prop $_ 'status')).ToLowerInvariant()
        $st -eq 'missing' -or $st -eq 'substituted'
      })
      $claims = @(Get-Prop $modelResult 'claims' | Where-Object { $null -ne $_ })
      $falseClaims = @($claims | Where-Object { (Get-Prop $_ 'holds') -eq $false })
      $followups = @(Get-Prop $modelResult 'followups' | Where-Object { $null -ne $_ })

      $effectiveVerdict = if ($rawVerdict -eq 'block' -or $blockingFindings.Count -gt 0 -or $failedAcceptance.Count -gt 0 -or $falseClaims.Count -gt 0) { 'block' } else { 'pass' }

      $recordObj = [ordered]@{
        pr = $prNum
        mergeCommit = $mergeSha
        linkedIssue = $issueNumber
        verdict = $effectiveVerdict
        rawVerdict = $rawVerdict
        deterministicFindings = $detFindings.ToArray()
        modelResult = $modelResult
        auditedAt = [DateTime]::UtcNow.ToString('yyyy-MM-ddTHH:mm:ssZ')
      }
      Write-TextUtf8 (Join-Path $runDir 'audit-result.json') ((ConvertTo-Json -InputObject $recordObj -Depth 10) + "`n")

      $createdFollowupNumbers = New-Object Collections.Generic.List[int]
      $writeFailed = $false

      if ($effectiveVerdict -eq 'block') {
        Write-AuditLog ('PR #' + $prNum + ' verdict=block blockingFindings=' + $blockingFindings.Count + ' followups=' + $followups.Count)
        $summary.blocked += $prNum

        # Reopen closed linked issue or comment on open linked issue.
        if ($issueNumber -gt 0 -and $null -ne $issueObj) {
          $issueMarker = '<!-- nyx-postaudit pr=' + $prNum + ' id=issue-notice -->'
          $alreadyCommented = $false
          try {
            $existingComments = Invoke-AuditApi -Config $config -Method 'GET' -Path ('/repos/' + $repo + '/issues/' + $issueNumber + '/comments?per_page=100')
            foreach ($c in @($existingComments)) {
              $cb = [string](Get-Prop $c 'body')
              if ($cb -and $cb.IndexOf($issueMarker, [StringComparison]::Ordinal) -ge 0) {
                $alreadyCommented = $true
                break
              }
            }
          } catch {
            Write-AuditLog ('warning: could not read comments on issue #' + $issueNumber + ': ' + (ConvertTo-SingleLine $_.Exception.Message 160))
          }

          $issueState = ([string](Get-Prop $issueObj 'state')).ToLowerInvariant()
          $commentBody = Build-IssueBlockComment -PrNumber $prNum -ShortSha $shortSha -BlockingFindings $blockingFindings -FailedAcceptance $failedAcceptance -FalseClaims $falseClaims -Marker $issueMarker
          Write-TextUtf8 (Join-Path $runDir ('issue-' + $issueNumber + '-comment.md')) $commentBody

          if ($DryRun) {
            Write-AuditLog ('dry-run: would ' + $(if ($issueState -eq 'closed') { 'reopen and comment on' } else { 'comment on' }) + ' linked issue #' + $issueNumber)
          } else {
            try {
              if ($issueState -eq 'closed') {
                $null = Invoke-AuditApi -Config $config -Method 'PATCH' -Path ('/repos/' + $repo + '/issues/' + $issueNumber) -Body @{ state = 'open' }
                Write-AuditLog ('reopened closed issue #' + $issueNumber + ' for PR #' + $prNum)
              }
              if (-not $alreadyCommented) {
                $null = Invoke-AuditApi -Config $config -Method 'POST' -Path ('/repos/' + $repo + '/issues/' + $issueNumber + '/comments') -Body @{ body = $commentBody }
                Write-AuditLog ('commented on issue #' + $issueNumber + ' for PR #' + $prNum)
              } else {
                Write-AuditLog ('issue #' + $issueNumber + ' already has post-audit comment for PR #' + $prNum)
              }
            } catch {
              $writeFailed = $true
              $eMsg = 'failed updating linked issue #' + $issueNumber + ': ' + (ConvertTo-SingleLine $_.Exception.Message 180)
              Write-AuditLog $eMsg
              $summary.errors += $eMsg
            }
          }
        }

        # Create deduped followup issues.
        $fIndex = 0
        foreach ($fu in $followups) {
          $fIndex++
          $fuTitleRaw = ([string](Get-Prop $fu 'title')).Trim()
          $fuBodyRaw = ([string](Get-Prop $fu 'body')).Trim()
          if ([string]::IsNullOrWhiteSpace($fuTitleRaw)) { continue }
          $fuBlocking = (Get-Prop $fu 'blocking')
          $fuId = Get-FollowupId -Followup $fu -Index $fIndex
          $marker = '<!-- nyx-postaudit pr=' + $prNum + ' id=' + $fuId + ' -->'
          $issueTitle = Protect-PublicText ('Audit follow-up (#' + $prNum + '): ' + $fuTitleRaw)
          if ($issueTitle.Length -gt 240) { $issueTitle = $issueTitle.Substring(0, 240).Trim() }

          $fuLines = New-Object Collections.Generic.List[string]
          $null = $fuLines.Add('> Automated post-merge audit follow-up (`nyx/audit`) for merged PR #' + $prNum + ' (`' + $shortSha + '`).')
          $null = $fuLines.Add('')
          if ($issueNumber -gt 0) {
            $null = $fuLines.Add('- Source PR: #' + $prNum + ' (linked issue #' + $issueNumber + ')')
          } else {
            $null = $fuLines.Add('- Source PR: #' + $prNum)
          }
          $null = $fuLines.Add('- Severity: ' + $(if ($fuBlocking -eq $false) { 'advisory' } else { 'blocking' }))
          $null = $fuLines.Add('')
          $null = $fuLines.Add($(if ($fuBodyRaw) { $fuBodyRaw } else { $fuTitleRaw }))
          $null = $fuLines.Add('')
          $null = $fuLines.Add($marker)
          $fuBody = Protect-PublicText (($fuLines -join "`n") + "`n")

          try {
            $existingFu = Find-ExistingIssueByMarker -Config $config -Repo $repo -Marker $marker
            if ($null -ne $existingFu) {
              Write-AuditLog ('followup already exists as issue #' + [string](Get-Prop $existingFu 'number') + ' for marker ' + $fuId)
              continue
            }
            if ($DryRun) {
              Write-AuditLog ('dry-run: would create followup issue "' + $issueTitle + '" (' + $marker + ')')
            } else {
              $createdFu = Invoke-AuditApi -Config $config -Method 'POST' -Path ('/repos/' + $repo + '/issues') -Body @{
                title = $issueTitle
                body = $fuBody
                labels = @('nyx-auto', 'audit-followup')
              }
              $newNo = [int](Get-Prop $createdFu 'number')
              $null = $createdFollowupNumbers.Add($newNo)
              $summary.followupsCreated += $newNo
              Write-AuditLog ('created followup issue #' + $newNo + ' for PR #' + $prNum + ' (' + $fuId + ')')
            }
          } catch {
            $writeFailed = $true
            $eMsg = 'failed creating followup (' + $fuId + ') for PR #' + $prNum + ': ' + (ConvertTo-SingleLine $_.Exception.Message 180)
            Write-AuditLog $eMsg
            $summary.errors += $eMsg
          }
        }
      } else {
        Write-AuditLog ('PR #' + $prNum + ' verdict=pass')
      }

      if (-not $DryRun -and -not $writeFailed) {
        $stateObj = [ordered]@{
          status = 'done'
          pr = $prNum
          mergeCommit = $mergeSha
          verdict = $effectiveVerdict
          linkedIssue = $issueNumber
          followupsCreated = @($createdFollowupNumbers.ToArray())
          runDir = $runDir
          completedAt = [DateTime]::UtcNow.ToString('yyyy-MM-ddTHH:mm:ssZ')
        }
        $statePath = Join-Path $stateDir ('post-' + $prNum + '.json')
        Write-TextAtomic $statePath ((ConvertTo-Json -InputObject $stateObj -Depth 6) + "`n")
        $summary.audited += $prNum
      } elseif ($DryRun) {
        $summary.audited += $prNum
      }
    } catch {
      $errText = 'PR #' + $prNum + ' failed: ' + (ConvertTo-SingleLine $_.Exception.Message 220)
      Write-AuditLog $errText
      $summary.errors += $errText
    } finally {
      if ($treeCreated -and $treeDir) {
        Stop-WorktreeProcesses $treeDir
        if (Test-Path -LiteralPath $treeDir) {
          $null = Invoke-GitCmd $repoDir ('worktree remove --force ' + (Quote-Arg $treeDir)) $runDir
        }
        if (Test-Path -LiteralPath $treeDir) {
          $null = Invoke-ProcessCapture $script:CmdExe ('/d /c rmdir /s /q ' + (Quote-Arg $treeDir)) (Join-Path $runDir '.rmdir.out.tmp') (Join-Path $runDir '.rmdir.err.tmp') $script:WorkRoot
        }
        $null = Invoke-GitCmd $repoDir 'worktree prune' $runDir
      }
    }
  }

  if (-not $DryRun) {
    $stillPending = @(@($pendingPrs) + @($targetPrs | ForEach-Object { [int](Get-Prop $_ 'number') }) | Sort-Object -Unique | Where-Object {
      -not (Test-PrStateDone (Join-Path $stateDir ('post-' + $_ + '.json')))
    })
    Write-TextAtomic $pendingPath ((ConvertTo-Json -InputObject @($stillPending) -Compress) + "`n")
  }

  $summary.ok = ($summary.errors.Count -eq 0)
  Write-AuditLog ('completed post-merge audit ok=' + $summary.ok + ' audited=' + @($summary.audited).Count + ' blocked=' + @($summary.blocked).Count + ' unavailable=' + @($summary.unavailable).Count + ' rulesetOk=' + $summary.rulesetOk)
} catch {
  $fatal = ConvertTo-SingleLine $_.Exception.Message 260
  Write-AuditLog ('fatal: ' + $fatal)
  $summary.errors += $fatal
  $summary.ok = $false
} finally {
  if ($lockStream) { $lockStream.Dispose() }
}

try { [Console]::OutputEncoding = New-Object Text.UTF8Encoding($false) } catch { }
[Console]::Out.WriteLine((ConvertTo-Json -InputObject $summary -Depth 5 -Compress))
if ($summary.ok) { exit 0 } else { exit 1 }
