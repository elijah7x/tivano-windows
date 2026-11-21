# Tivano Windows - derived from Tivano (AGPL-3.0), modified 2026-11-21.
# Droppy Code by Jordy Spruit (Droppy), https://getdroppycode.app
# Usage: .\Invoke-Audit.ps1 [-ConfigPath <path>] [-PrNumber <n>] [-DryRun]
# Independent PR auditor for nyx/* PRs targeting main. Acts solely via GitHub App token through AuditChecks.psm1 (never gh CLI).

param(
  [string]$ConfigPath = 'C:\tivano\audit\config.json',
  [int]$PrNumber = 0,
  [switch]$DryRun
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

Import-Module (Join-Path $PSScriptRoot 'AuditChecks.psm1') -Force

$script:CmdExe = Join-Path ([Environment]::GetFolderPath('System')) 'cmd.exe'
$script:GitPath = $null
$script:WorkRoot = $null
$script:LogPath = $null
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
  $line = [DateTime]::Now.ToString('yyyy-MM-ddTHH:mm:ss') + ' ' + $safe + "`r`n"
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
  $baseDir = if (-not [string]::IsNullOrWhiteSpace($TempBase)) { $TempBase } else { $script:WorkRoot }
  $out = Join-Path $baseDir '.git.out.tmp'
  $err = Join-Path $baseDir '.git.err.tmp'
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
    round = 0
    lastCommentId = [long]0
    lastCommentCreatedAt = ''
    lastRebuttalCommentId = [long]0
    pendingRebuttalCommentId = [long]0
    verdict = ''
    baseSha = ''
    priorFindings = @()
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
  $upd = Get-JsonProp $data 'updatedAt'
  if ($null -ne $upd) { $default['updatedAt'] = [string]$upd }

  return [pscustomobject]$default
}

function Save-PrState {
  param(
    [string]$Path,
    $State
  )
  $State.updatedAt = [DateTime]::UtcNow.ToString('yyyy-MM-ddTHH:mm:ssZ')
  $tmp = $Path + '.tmp'
  Write-Text $tmp ((ConvertTo-Json -InputObject $State -Depth 8) + "`n")
  if (Test-Path -LiteralPath $Path) {
    [IO.File]::Replace($tmp, $Path, [NullString]::Value)
  } else {
    [IO.File]::Move($tmp, $Path)
  }
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
  return @($all)
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

  $markerPattern = '<!--\s*nyx-audit\s+sha=' + [regex]::Escape($HeadSha) + '\s+round=([0-9]+)\s*-->'
  foreach ($c in @($Comments)) {
    $cid = [long](Get-JsonProp $c 'id')
    $body = [string](Get-JsonProp $c 'body')
    if ($cid -eq $lastAuditId -or $body -match $markerPattern) {
      if ($cid -ge $lastAuditId) {
        $lastAuditId = $cid
        $lastAuditBody = $body
        $created = [string](Get-JsonProp $c 'created_at')
        if (-not [string]::IsNullOrWhiteSpace($created)) {
          try { $lastAuditAt = [DateTimeOffset]::Parse($created) } catch { }
        }
        $userObj = Get-JsonProp $c 'user'
        $login = [string](Get-JsonProp $userObj 'login')
        if (-not [string]::IsNullOrWhiteSpace($login)) { $auditBotLogin = $login }
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

function Add-NeedsHumanLabel {
  param(
    $Config,
    [int]$Number
  )
  $repo = $Config.repo
  $exists = $false
  try {
    $null = Invoke-AuditApi -Config $Config -Method 'GET' -Path ('/repos/' + $repo + '/labels/needs-human')
    $exists = $true
  } catch {
    $exists = $false
  }
  if (-not $exists) {
    try {
      $null = Invoke-AuditApi -Config $Config -Method 'POST' -Path ('/repos/' + $repo + '/labels') -Body @{
        name = 'needs-human'
        color = 'd93f0b'
        description = 'Needs human maintainer review'
      }
    } catch {
      Write-Log ('create needs-human label note: ' + (ConvertTo-SingleLine $_.Exception.Message 160))
    }
  }
  $null = Invoke-AuditApi -Config $Config -Method 'POST' -Path ('/repos/' + $repo + '/issues/' + $Number + '/labels') -Body @{
    labels = @('needs-human')
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
  $comments = Get-PrComments -Config $Config -Number $IssueNumber
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

function Get-DeterministicFindings {
  param(
    [string]$Worktree,
    [string]$HeadRef,
    [string[]]$ChangedFiles,
    [int]$IssueNumber,
    [string]$IssueError = '',
    [string]$TempBase = ''
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
    $beforeRes = Invoke-Git -Directory $Worktree -Arguments 'show origin/main:package.json' -TempBase $TempBase
    $beforeSig = if ($beforeRes.exitCode -eq 0) { Get-DependencySignature ([string]$beforeRes.text) } else { $null }
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
    $beforeRes = Invoke-Git -Directory $Worktree -Arguments 'show origin/main:docs/parity.md' -TempBase $TempBase
    $beforeMap = if ($beforeRes.exitCode -eq 0) { Get-ParityStatus ([string]$beforeRes.text) } else { @{} }
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
  $testsDiffRes = Invoke-Git -Directory $Worktree -Arguments '-c core.quotepath=false diff --cached --no-renames -U0 origin/main -- tests' -TempBase $TempBase
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

  $fullDiffRes = Invoke-Git -Directory $Worktree -Arguments '-c core.quotepath=false diff --cached --no-renames -U0 origin/main' -TempBase $TempBase
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
    [bool]$NeedsHumanEscalation = $false
  )
  $sha7 = if ($HeadSha.Length -ge 7) { $HeadSha.Substring(0, 7) } else { $HeadSha }
  $verdictLabel = if ($Verdict -eq 'pass') { 'PASS' } else { 'BLOCK' }

  $lines = New-Object Collections.Generic.List[string]
  $null = $lines.Add('## Nyx audit - ' + $sha7 + ' - ' + $verdictLabel)
  $null = $lines.Add('')
  $issueLabel = if ($IssueNumber -gt 0) { '#' + $IssueNumber } else { 'none' }
  $null = $lines.Add('Round: ' + $Round + ' | Linked issue: ' + $issueLabel)
  if ($NeedsHumanEscalation) {
    $null = $lines.Add('')
    $null = $lines.Add('> Still blocking after rebuttal round ' + $Round + '; added the `needs-human` label for maintainer review.')
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
  return (Protect-PublicText (($lines -join "`n") + "`n"))
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

$lock = $null
$resultsOut = New-Object Collections.Generic.List[object]
$skippedOut = New-Object Collections.Generic.List[object]
$errorsOut = New-Object Collections.Generic.List[object]
$exitCode = 0

try {
  $config = Get-AuditConfig -Path $ConfigPath
  $script:WorkRoot = [IO.Path]::GetFullPath([string]$config.workRoot).TrimEnd('\')
  Assert-OutsideGitCheckout $script:WorkRoot

  $stateDir = Join-Path $script:WorkRoot 'state'
  $runsDir = Join-Path $script:WorkRoot 'runs'
  $logsDir = Join-Path $script:WorkRoot 'logs'
  $repoDir = Join-Path $script:WorkRoot 'repo'

  [IO.Directory]::CreateDirectory($script:WorkRoot) | Out-Null
  [IO.Directory]::CreateDirectory($stateDir) | Out-Null
  [IO.Directory]::CreateDirectory($runsDir) | Out-Null
  [IO.Directory]::CreateDirectory($logsDir) | Out-Null

  $script:LogPath = Join-Path $logsDir ('audit-' + [DateTime]::Now.ToString('yyyyMMdd') + '.log')
  Initialize-Redactions @($script:WorkRoot, [string]$config.referenceRoot, [string]$config.keyPath)

  $lockPath = Join-Path $script:WorkRoot 'audit.lock'
  try {
    $lock = [IO.File]::Open($lockPath, [IO.FileMode]::OpenOrCreate, [IO.FileAccess]::ReadWrite, [IO.FileShare]::None)
  } catch {
    Write-Log 'another audit run holds audit.lock; exiting'
    $null = $skippedOut.Add([ordered]@{ pr = $null; reason = 'another audit run holds the lock' })
    $lock = $null
  }

  if ($null -ne $lock) {
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

    $pulls = @(Get-OpenNyxPulls -Config $config -OnlyPrNumber $PrNumber)
    Write-Log ('audit pass started: repo=' + $config.repo + ' openNyxPrs=' + $pulls.Count + ' dryRun=' + [bool]$DryRun)

    $mainSha = ''
    if ($pulls.Count -gt 0) {
      Ensure-AuditRepo -Config $config -RepoDir $repoDir
      $mainShaRes = Invoke-Git -Directory $repoDir -Arguments 'rev-parse origin/main'
      $mainSha = if ($mainShaRes.exitCode -eq 0) { ([string]$mainShaRes.text).Trim() } else { '' }
    }

    foreach ($pr in $pulls) {
      $num = [int]$pr.number
      $headObj = Get-JsonProp $pr 'head'
      $headSha = [string](Get-JsonProp $headObj 'sha')
      $headRef = [string](Get-JsonProp $headObj 'ref')
      $prTitle = [string](Get-JsonProp $pr 'title')
      $prBody = [string](Get-JsonProp $pr 'body')
      if ([string]::IsNullOrWhiteSpace($headSha) -or $headSha.Length -lt 7) {
        $null = $skippedOut.Add([ordered]@{ pr = $num; reason = 'missing head SHA' })
        continue
      }
      $sha7 = $headSha.Substring(0, 7)
      $statePath = Join-Path $stateDir ('pr-' + $num + '.json')
      $state = Read-PrState -Path $statePath -Number $num

      $isNewHead = ($state.headSha -ne $headSha)
      if ($isNewHead) {
        $state.headSha = $headSha
        $state.attempts = 0
        $state.round = 0
        $state.lastCommentId = [long]0
        $state.lastCommentCreatedAt = ''
        $state.lastRebuttalCommentId = [long]0
        $state.pendingRebuttalCommentId = [long]0
        $state.verdict = ''
        $state.priorFindings = @()
      }

      $rebuttalText = 'none'
      $priorFindingsText = 'none'
      $rebuttalCommentId = [long]0

      if (-not $isNewHead) {
        # A pass holds only for the main it was trial-merged onto; re-audit when main moves.
        if ($state.verdict -eq 'pass' -and -not [string]::IsNullOrWhiteSpace($mainSha) -and $state.baseSha -eq $mainSha) {
          $null = $skippedOut.Add([ordered]@{ pr = $num; sha = $sha7; reason = 'already passed for head ' + $sha7 })
          continue
        }
        if ($state.verdict -eq 'unavailable-failed' -or ([string]::IsNullOrWhiteSpace($state.verdict) -and [int]$state.attempts -ge 3)) {
          $null = $skippedOut.Add([ordered]@{ pr = $num; sha = $sha7; reason = 'reached 3 failed audit attempts for head ' + $sha7 })
          continue
        }
        if ($state.verdict -eq 'block') {
          if ([int]$state.round -ge 2) {
            $null = $skippedOut.Add([ordered]@{ pr = $num; sha = $sha7; reason = 'already completed rebuttal round for head ' + $sha7 })
            continue
          }
          $comments = @(Get-PrComments -Config $config -Number $num)
          $rebuttal = Find-NewRebuttal -Comments $comments -State $state -Config $config -HeadSha $headSha
          if ($null -eq $rebuttal) {
            $null = $skippedOut.Add([ordered]@{ pr = $num; sha = $sha7; reason = 'already blocked for head ' + $sha7 + ' with no new rebuttal' })
            continue
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
          }
          Write-Log ('PR #' + $num + ' head ' + $sha7 + ': detected new rebuttal comment ' + $rebuttalCommentId + ', starting round ' + ([int]$state.round + 1))
        }
      }

      $nextRound = [int]$state.round + 1
      $runDirName = 'pr-' + $num + '-' + $sha7
      $runDir = Join-Path $runsDir $runDirName
      if (Test-Path -LiteralPath $runDir) {
        $runDir = Join-Path $runsDir ($runDirName + '-r' + $nextRound + '-' + [DateTime]::Now.ToString('yyyyMMddTHHmmss'))
      }
      [IO.Directory]::CreateDirectory($runDir) | Out-Null

      $worktreeDir = Join-Path $runDir 'worktree'
      $worktreeCreated = $false
      $pendingSet = $false

      try {
        Write-Log ('auditing PR #' + $num + ' head ' + $sha7 + ' round ' + $nextRound)
        if (-not $DryRun) {
          Set-AuditCommitStatus -Config $config -Sha $headSha -State 'pending' -Description ('Nyx audit running (round ' + $nextRound + ')')
          $pendingSet = $true
        }

        $fetchPr = Invoke-Git -Directory $repoDir -Arguments ('fetch --no-tags origin +refs/pull/' + $num + '/head:refs/audit/pr-' + $num) -AuthConfig $config -TempBase $runDir
        if ($fetchPr.exitCode -ne 0) {
          throw ('git fetch PR #' + $num + ' failed: ' + (ConvertTo-SingleLine $fetchPr.error 240))
        }
        $revCheck = Invoke-Git -Directory $repoDir -Arguments ('rev-parse --verify refs/audit/pr-' + $num) -TempBase $runDir
        $fetchedSha = if ($revCheck.exitCode -eq 0 -and $revCheck.text) { $revCheck.text.Trim() } else { '' }
        if ($fetchedSha -ne $headSha) {
          Write-Log ('PR #' + $num + ' head moved during fetch (expected ' + $sha7 + ', got ' + $fetchedSha + '); skipping')
          $null = $skippedOut.Add([ordered]@{ pr = $num; sha = $sha7; reason = 'head moved during fetch' })
          continue
        }

        $wtAdd = Invoke-Git -Directory $repoDir -Arguments ('worktree add --detach ' + (Quote-Arg $worktreeDir) + ' origin/main') -TempBase $runDir
        if ($wtAdd.exitCode -ne 0) {
          throw ('git worktree add failed: ' + (ConvertTo-SingleLine $wtAdd.error 240))
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
        $issueBody = 'No linked issue found.'
        $issueError = ''
        if ($issueNumber -gt 0) {
          try {
            $issueBody = Get-IssueMarkdown -Config $config -IssueNumber $issueNumber
          } catch {
            $issueError = ConvertTo-SingleLine $_.Exception.Message 240
            $issueBody = 'Failed to fetch linked issue #' + $issueNumber + ': ' + $issueError
          }
        }

        $acceptance = @()
        $claims = @()
        $withdrawn = @()
        $allFindings = New-Object Collections.Generic.List[object]
        $modelVerdict = ''
        $finalVerdict = 'block'

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
          $namesRes = Invoke-Git -Directory $worktreeDir -Arguments '-c core.quotepath=false diff --cached --no-renames --name-only -z origin/main' -TempBase $runDir
          if ($namesRes.exitCode -ne 0) {
            throw ('git diff --name-only failed: ' + (ConvertTo-SingleLine $namesRes.error 240))
          }
          $changedFiles = @(([string]$namesRes.text) -split "`0" | Where-Object { $_ })

          $statRes = Invoke-Git -Directory $worktreeDir -Arguments 'diff --cached --stat origin/main' -TempBase $runDir
          $diffStat = if ($statRes.exitCode -eq 0 -and -not [string]::IsNullOrWhiteSpace($statRes.text)) { $statRes.text.TrimEnd() } else { '(empty diff against origin/main)' }
          Write-Text (Join-Path $runDir 'diff.stat.txt') ($diffStat + "`n")

          $diffOutPath = Join-Path $runDir 'diff.patch'
          $diffErrPath = Join-Path $runDir 'diff.err.log'
          $null = Invoke-Tool $script:GitPath ('-C ' + (Quote-Arg $worktreeDir) + ' diff --cached origin/main') $diffOutPath $diffErrPath $script:WorkRoot

          $detFindings = @(Get-DeterministicFindings -Worktree $worktreeDir -HeadRef $headRef -ChangedFiles $changedFiles -IssueNumber $issueNumber -IssueError $issueError -TempBase $runDir)
          foreach ($df in $detFindings) { $null = $allFindings.Add($df) }

          $values = @{
            PR_NUMBER = [string]$num
            PR_TITLE = $prTitle
            PR_BODY = $(if ([string]::IsNullOrWhiteSpace($prBody)) { '(empty)' } else { $prBody })
            ISSUE_NUMBER = $(if ($issueNumber -gt 0) { '#' + $issueNumber } else { 'none' })
            ISSUE_BODY = $issueBody
            DIFF_STAT = $diffStat
            DETERMINISTIC_FINDINGS = (Format-FindingsForPrompt $detFindings)
            REFERENCE_ROOT = [string]$config.referenceRoot
            PRIOR_FINDINGS = $priorFindingsText
            REBUTTAL = $rebuttalText
          }
          $filledPrompt = [regex]::Replace(
            $promptTemplate,
            '\{\{(PR_NUMBER|PR_TITLE|PR_BODY|ISSUE_NUMBER|ISSUE_BODY|DIFF_STAT|DETERMINISTIC_FINDINGS|REFERENCE_ROOT|PRIOR_FINDINGS|REBUTTAL)\}\}',
            [Text.RegularExpressions.MatchEvaluator]{ param($m) [string]$values[$m.Groups[1].Value] }
          )

          $extraReadDirs = @()
          if (-not [string]::IsNullOrWhiteSpace([string]$config.referenceRoot)) {
            $extraReadDirs = @([string]$config.referenceRoot)
          }

          $modelRes = $null
          for ($modelTry = 1; $modelTry -le 2; $modelTry++) {
            $modelRes = Invoke-AuditModel -Config $config -PromptText $filledPrompt -WorkDir $worktreeDir -ExtraReadDirs $extraReadDirs -RunDir $runDir
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
            $errReason = if ($null -ne $modelRes -and -not [string]::IsNullOrWhiteSpace([string]$modelRes.error)) { [string]$modelRes.error } else { 'audit model unavailable' }
            $newAttempts = [int]$state.attempts + 1
            $state.attempts = $newAttempts
            $reachedMax = ($newAttempts -ge 3)
            if ($reachedMax) {
              $state.verdict = 'unavailable-failed'
            }
            if (-not $DryRun) {
              Save-PrState -Path $statePath -State $state
              if ($reachedMax) {
                Set-AuditCommitStatus -Config $config -Sha $headSha -State 'failure' -Description 'audit unavailable after 3 attempts; needs-human'
                Add-NeedsHumanLabel -Config $config -Number $num
              } else {
                Set-AuditCommitStatus -Config $config -Sha $headSha -State 'error' -Description 'audit unavailable, will retry'
              }
            }
            $unavailRecord = [ordered]@{
              pr = $num
              headSha = $headSha
              round = $nextRound
              status = 'unavailable'
              attempts = $newAttempts
              commitStatus = $(if ($reachedMax) { 'failure' } else { 'error' })
              needsHuman = $reachedMax
              error = $errReason
              runDir = $runDir
            }
            Write-Text (Join-Path $runDir 'result.json') ((ConvertTo-Json -InputObject $unavailRecord -Depth 6) + "`n")
            $null = $resultsOut.Add($unavailRecord)
            Write-Log ('PR #' + $num + ' head ' + $sha7 + ' failed closed (attempts=' + $newAttempts + '): ' + $errReason)
            continue
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
          foreach ($f in $allFindings) {
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

        $needsHumanEscalation = ($finalVerdict -eq 'block' -and $nextRound -ge 2)
        $findingsArray = @($allFindings.ToArray())
        $commentBody = Build-AuditCommentBody `
          -HeadSha $headSha `
          -Round $nextRound `
          -Verdict $finalVerdict `
          -IssueNumber $issueNumber `
          -Acceptance $acceptance `
          -Findings $findingsArray `
          -Claims $claims `
          -Withdrawn $withdrawn `
          -NeedsHumanEscalation $needsHumanEscalation
        Write-Text (Join-Path $runDir 'comment.md') $commentBody

        $blockingCount = 0
        $advisoryCount = 0
        foreach ($f in $findingsArray) {
          if (([string](Get-JsonProp $f 'severity')).Trim().ToLowerInvariant() -eq 'blocking') { $blockingCount++ } else { $advisoryCount++ }
        }
        $failingAccCount = 0
        foreach ($a in $acceptance) {
          $ast = ([string](Get-JsonProp $a 'status')).Trim().ToLowerInvariant()
          if ($ast -eq 'missing' -or $ast -eq 'substituted') { $failingAccCount++ }
        }
        $failingClaimsCount = 0
        foreach ($cl in $claims) {
          $hv = Get-JsonProp $cl 'holds'
          if ($hv -is [bool] -and -not $hv) { $failingClaimsCount++ }
        }

        $ghStatus = if ($finalVerdict -eq 'pass') { 'success' } else { 'failure' }
        if ($finalVerdict -eq 'pass') {
          $statusDesc = 'Nyx audit passed (round ' + $nextRound + ', ' + $advisoryCount + ' advisory)'
        } else {
          $parts = @()
          if ($blockingCount -gt 0) { $parts += ($blockingCount.ToString() + ' blocking') }
          if ($failingAccCount -gt 0) { $parts += ($failingAccCount.ToString() + ' missing/substituted') }
          if ($failingClaimsCount -gt 0) { $parts += ($failingClaimsCount.ToString() + ' false claim(s)') }
          $detail = if ($parts.Count -gt 0) { $parts -join ', ' } else { 'blocked' }
          $statusDesc = 'Nyx audit blocked (round ' + $nextRound + '): ' + $detail
          if ($needsHumanEscalation) { $statusDesc += '; needs-human' }
        }
        $statusDesc = ConvertTo-SingleLine $statusDesc 140

        $commentUrl = ''
        $commentId = [long]0
        if (-not $DryRun) {
          $posted = Invoke-AuditApi -Config $config -Method 'POST' -Path ('/repos/' + $config.repo + '/issues/' + $num + '/comments') -Body @{ body = $commentBody }
          $commentId = [long](Get-JsonProp $posted 'id')
          $commentUrl = [string](Get-JsonProp $posted 'html_url')
          $commentCreated = [string](Get-JsonProp $posted 'created_at')

          Set-AuditCommitStatus -Config $config -Sha $headSha -State $ghStatus -Description $statusDesc -TargetUrl $commentUrl
          if ($needsHumanEscalation) {
            Add-NeedsHumanLabel -Config $config -Number $num
          }

          $state.headSha = $headSha
          $state.round = $nextRound
          $state.lastCommentId = $commentId
          $state.lastCommentCreatedAt = $commentCreated
          if ($rebuttalCommentId -gt 0) { $state.lastRebuttalCommentId = $rebuttalCommentId }
          $state.pendingRebuttalCommentId = [long]0
          $state.verdict = $finalVerdict
          $state.baseSha = $mainSha
          $state.priorFindings = $findingsArray
          Save-PrState -Path $statePath -State $state
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
          needsHuman = $needsHumanEscalation
          issueNumber = $issueNumber
          acceptance = @($acceptance)
          findings = @($findingsArray)
          claims = @($claims)
          withdrawn = @($withdrawn)
          runDir = $runDir
        }
        Write-Text (Join-Path $runDir 'result.json') ((ConvertTo-Json -InputObject $prRecord -Depth 8) + "`n")
        $null = $resultsOut.Add($prRecord)
        Write-Log ('PR #' + $num + ' head ' + $sha7 + ' round ' + $nextRound + ' verdict=' + $finalVerdict + ' status=' + $ghStatus)
      } catch {
        $errMsg = ConvertTo-SingleLine (Protect-LogText $_.Exception.Message) 300
        Write-Log ('PR #' + $num + ' head ' + $sha7 + ' error: ' + $errMsg)
        if ($pendingSet -and -not $DryRun) {
          try { Set-AuditCommitStatus -Config $config -Sha $headSha -State 'error' -Description 'audit unavailable, will retry' } catch { }
        }
        $null = $errorsOut.Add([ordered]@{ pr = $num; headSha = $headSha; error = $errMsg; runDir = $runDir })
      } finally {
        if ($worktreeCreated -and -not [string]::IsNullOrWhiteSpace($worktreeDir)) {
          Stop-WorktreeProcesses $worktreeDir
          if ($script:GitPath -and (Test-Path -LiteralPath (Join-Path $repoDir '.git'))) {
            if (Test-Path -LiteralPath $worktreeDir) {
              $null = Invoke-Git -Directory $repoDir -Arguments ('worktree remove --force ' + (Quote-Arg $worktreeDir)) -TempBase $runDir
            }
            if (Test-Path -LiteralPath $worktreeDir) {
              $null = Invoke-Tool $script:CmdExe ('/d /c rmdir /s /q ' + (Quote-Arg $worktreeDir)) (Join-Path $runDir '.rmdir.out.tmp') (Join-Path $runDir '.rmdir.err.tmp') $script:WorkRoot
            }
            $null = Invoke-Git -Directory $repoDir -Arguments 'worktree prune' -TempBase $runDir
          }
        }
      }
    }

    Remove-ExcessRuns -RunsDir $runsDir -Keep 20
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
