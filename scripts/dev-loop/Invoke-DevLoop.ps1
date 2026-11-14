# Tivano Windows - derived from Tivano (AGPL-3.0), modified 2026-11-14.
# Droppy Code by Jordy Spruit (Droppy), https://getdroppycode.app
# Usage: .\Invoke-DevLoop.ps1 -Root <state root outside any git checkout> -Checkout <clone used for worktrees> -ReviewRoot <pr-review state root> -StandardCredentialFile <file> [-ReviewCheckout <clone>] [-ReviewTokenFile <file>] [-Reference <macOS baseline clone>] [-IssueNumber <n>] [-TrackingIssue <n>] [-StallMinutes <n>] [-DryRun]
# Continuous development pass: resumes open nyx/ PRs and works through all eligible labelled issues (develop, review, fix, merge) until none remain, STOP exists, or a cap is reached. Writes a one-line JSON summary to stdout and <Root>\last-run.json.

param(
  [string]$Repo = 'elijah7x/tivano-windows',
  [string]$Root,
  [string]$Checkout,
  [string]$ReviewRoot,
  [string]$ReviewCheckout,
  [string]$StandardCredentialFile,
  [string]$ReviewTokenFile,
  [string]$Reference,
  [ValidatePattern('^[A-Za-z0-9._:/-]+$')][string]$DevinModel = 'swe-2-high',
  [ValidatePattern('^[A-Za-z0-9_.-]+$')][string]$Label = 'nyx-auto',
  [ValidateRange(1, 200)][int]$MaxIssuesPerRun = 50,
  [ValidateRange(1, 200)][int]$MaxMergesPerDay = 20,
  [ValidateRange(0, 5)][int]$MaxFixRounds = 2,
  [ValidateRange(5, 480)][int]$DevinTimeoutMin = 90,
  # gui: the task is typed into a Devin Desktop chat on the signed-in desktop, so it can be watched and joined there.
  # cli: a headless Devin CLI run in a console window. Its session cannot be opened in Devin Desktop while it runs.
  [ValidateSet('gui', 'cli')][string]$DevinFrontEnd = 'gui',
  [int]$IssueNumber = 0,
  [int]$TrackingIssue = 0,
  [ValidateRange(5, 240)][int]$StallMinutes = 20,
  [switch]$DryRun
)

$ErrorActionPreference = 'Stop'
# Shared path validation: rejects UNC/device paths, junctions and short-name aliases.
. (Join-Path $PSScriptRoot '..\windows-acceptance\Invoke-InteractiveSession.ps1')

$script:GitPath = $null
$script:GhPath = $null
$script:DevinPath = $null
$script:CmdExe = Join-Path ([Environment]::GetFolderPath('System')) 'cmd.exe'
$script:PowerShellExe = Join-Path ([Environment]::GetFolderPath('System')) 'WindowsPowerShell\v1.0\powershell.exe'
$script:ReviewScript = Join-Path $PSScriptRoot '..\pr-review\Invoke-PrReview.ps1'
$script:DevPrompt = Join-Path $PSScriptRoot 'dev-prompt.md'
$script:FixPrompt = Join-Path $PSScriptRoot 'fix-prompt.md'
$script:ReviewTimeoutMin = 240

# The runner refuses to open a PR that touches these; they define how the loop itself is governed.
$script:GuardedPrefixes = @('scripts/dev-loop/', 'scripts/pr-review/', 'scripts/windows-acceptance/', '.github/')
$script:GuardedFiles = @('agents.md', 'contributing.md', 'license', 'third_party_notices.md', 'trademark.md', 'docs/source-baseline.json', 'package-lock.json')
$script:DependencySections = @('dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies', 'bundledDependencies', 'bundleDependencies', 'overrides')

$script:WorkRoot = $null
$script:LogPath = $null
$script:LogsDir = $null
$script:RunsDir = $null
$script:StatePath = $null
$script:State = $null
$script:Me = $null
$script:GitIdentity = ''
$script:LabelsReady = @{}
$script:Redactions = @()
$script:FinishedTrees = New-Object Collections.Generic.List[object]
$script:ResolvedTrackingIssue = 0
$script:LastUnitTitle = ''
$script:LastUnitDetail = ''

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

function Write-Log {
  param([string]$Message)
  if (-not $script:LogPath) { return }
  $line = [DateTime]::Now.ToString('yyyy-MM-ddTHH:mm:ss') + ' ' + $Message + "`r`n"
  try { [IO.File]::AppendAllText($script:LogPath, $line, (New-Object Text.UTF8Encoding($false))) } catch { }
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

function Invoke-Git {
  param([string]$Directory, [string]$Arguments)
  $out = Join-Path $script:WorkRoot '.git.out.tmp'
  $err = Join-Path $script:WorkRoot '.git.err.tmp'
  $code = Invoke-Tool $script:GitPath ('-C ' + (Quote-Argument $Directory) + ' ' + $Arguments) $out $err $script:WorkRoot
  return [pscustomobject]@{ exitCode = $code; text = (Read-Text $out); error = (Read-Text $err) }
}

# Runs from the state root, which is never a git checkout, so gh never reads repository context from the cwd.
function Invoke-Gh {
  param([string]$Arguments)
  $out = Join-Path $script:WorkRoot '.gh.out.tmp'
  $err = Join-Path $script:WorkRoot '.gh.err.tmp'
  $code = Invoke-Tool $script:GhPath $Arguments $out $err $script:WorkRoot
  return [pscustomobject]@{ exitCode = $code; text = (Read-Text $out); error = (Read-Text $err) }
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

function Get-ErrorSummary {
  param($Result)
  $text = [string]$Result.error
  if ([string]::IsNullOrWhiteSpace($text)) { $text = [string]$Result.text }
  $text = $text.Trim()
  if ($text.Length -gt 300) { $text = $text.Substring(0, 300) }
  return $text
}

function Read-JsonFile {
  param([string]$Path)
  $text = Read-Text $Path
  if ([string]::IsNullOrWhiteSpace($text)) { return $null }
  try { return ($text | ConvertFrom-Json) } catch { return $null }
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

# Paths end up inside a cmd.exe command line, where %VAR% expands even in quotes.
function Assert-CmdSafePath {
  param([string]$Name, [string]$Path)
  if ($Path.Contains('%') -or $Path.Contains('"') -or $Path.Contains("`r") -or $Path.Contains("`n")) {
    throw "$Name cannot contain percent signs, quotes or newlines."
  }
}

function Test-Stop {
  return (Test-Path -LiteralPath (Join-Path $script:WorkRoot 'STOP'))
}

# ---- state ----

function New-IssueEntry {
  return @{
    attempts = 0; status = 'new'; branch = $null; pr = $null; lastRunDir = $null
    fixRounds = 0; reviewFailures = 0; mergeFailures = 0; gateHead = $null; gatePath = $null; flakeNames = @()
    skipNotified = $false
  }
}

function Read-State {
  param([string]$Path)
  $state = @{ issues = @{}; merges = @{}; trackingIssue = 0; queueEmptyNotified = $false; mergeCapNotifiedDate = '' }
  $data = Read-JsonFile $Path
  if (-not $data) { return $state }
  if ($data.PSObject.Properties['issues'] -and $data.issues) {
    foreach ($property in $data.issues.PSObject.Properties) {
      $entry = New-IssueEntry
      foreach ($key in @($entry.Keys)) {
        if ($property.Value.PSObject.Properties[$key] -and $null -ne $property.Value.$key) { $entry[$key] = $property.Value.$key }
      }
      $state.issues[$property.Name] = $entry
    }
  }
  if ($data.PSObject.Properties['merges'] -and $data.merges) {
    foreach ($property in $data.merges.PSObject.Properties) { $state.merges[$property.Name] = [int]$property.Value }
  }
  if ($data.PSObject.Properties['trackingIssue'] -and $null -ne $data.trackingIssue) {
    $state.trackingIssue = [int]$data.trackingIssue
  }
  if ($data.PSObject.Properties['queueEmptyNotified'] -and $null -ne $data.queueEmptyNotified) {
    $state.queueEmptyNotified = [bool]$data.queueEmptyNotified
  }
  if ($data.PSObject.Properties['mergeCapNotifiedDate'] -and $null -ne $data.mergeCapNotifiedDate) {
    $state.mergeCapNotifiedDate = [string]$data.mergeCapNotifiedDate
  }
  return $state
}

function Save-State {
  # Keep two weeks of per-day merge counts; only today's count gates anything.
  $cutoff = [DateTime]::Now.AddDays(-14).ToString('yyyy-MM-dd')
  foreach ($day in @($script:State.merges.Keys)) {
    if ([string]::CompareOrdinal([string]$day, $cutoff) -lt 0) { $script:State.merges.Remove($day) }
  }
  $temporary = $script:StatePath + '.tmp'
  Write-Text $temporary ((ConvertTo-Json -InputObject $script:State -Depth 8) + "`n")
  if (Test-Path -LiteralPath $script:StatePath) {
    # PowerShell turns $null into an empty string for a string parameter; File.Replace needs a real null.
    [IO.File]::Replace($temporary, $script:StatePath, [NullString]::Value)
  } else {
    [IO.File]::Move($temporary, $script:StatePath)
  }
}

function Get-IssueEntry {
  param([int]$Number)
  $key = [string]$Number
  if (-not $script:State.issues.ContainsKey($key)) { $script:State.issues[$key] = New-IssueEntry }
  return $script:State.issues[$key]
}

function Get-MergesToday {
  $today = [DateTime]::Now.ToString('yyyy-MM-dd')
  if ($script:State.merges.ContainsKey($today)) { return [int]$script:State.merges[$today] }
  return 0
}

function Add-MergeToday {
  $today = [DateTime]::Now.ToString('yyyy-MM-dd')
  $script:State.merges[$today] = (Get-MergesToday) + 1
  Save-State
}

# ---- text safety ----

# Text from the agent is published on GitHub. Scrub the runner's own paths and the profile path
# as a backstop to the prompt rule; this is best effort, not a guarantee.
function Protect-PublicText {
  param([AllowEmptyString()][string]$Text)
  if ([string]::IsNullOrEmpty($Text)) { return '' }
  $result = $Text
  foreach ($secret in $script:Redactions) {
    $result = [regex]::Replace($result, [regex]::Escape($secret), '<redacted>', [Text.RegularExpressions.RegexOptions]::IgnoreCase)
  }
  return $result
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

function ConvertTo-Slug {
  param([string]$Title)
  $slug = ([regex]::Replace($Title.ToLowerInvariant(), '[^a-z0-9]+', '-')).Trim('-')
  if ($slug.Length -gt 40) { $slug = $slug.Substring(0, 40).Trim('-') }
  if (-not $slug) { $slug = 'work' }
  return $slug
}

# ---- GitHub writes (all of them are skipped under -DryRun) ----

function Initialize-Label {
  param([string]$Name, [string]$Color, [string]$Description)
  if ($DryRun -or $script:LabelsReady.ContainsKey($Name)) { return }
  # Fails harmlessly when the label already exists; the next step reports a label that really is missing.
  $null = Invoke-Gh ('label create ' + $Name + ' -R ' + $Repo + ' --color ' + $Color + ' --description ' + (Quote-Argument $Description))
  $script:LabelsReady[$Name] = $true
}

function Add-GhLabel {
  param([string]$Kind, [int]$Number, [string]$Name)
  if ($DryRun) { Write-Log ('DryRun: would label ' + $Kind + ' #' + $Number + ' ' + $Name); return }
  $result = Invoke-Gh ($Kind + ' edit ' + $Number + ' -R ' + $Repo + ' --add-label ' + $Name)
  if ($result.exitCode -ne 0) { Write-Log ('could not label ' + $Kind + ' #' + $Number + ' ' + $Name + ': ' + (Get-ErrorSummary $result)) }
}

function Add-GhComment {
  param([string]$Kind, [int]$Number, [string]$Text, [string]$RunDir)
  if ($DryRun) { Write-Log ('DryRun: would comment on ' + $Kind + ' #' + $Number + ': ' + (ConvertTo-SingleLine $Text 300)); return }
  $path = Join-Path $RunDir ('comment-' + [Guid]::NewGuid().ToString('N').Substring(0, 8) + '.md')
  $body = '> Automated by the dev-loop runner (Devin CLI on a Windows test machine). Agent self-tested; not a maintainer decision.' +
    "`n`n" + (Protect-PublicText $Text).Trim() + "`n"
  Write-Text $path $body
  $result = Invoke-Gh ($Kind + ' comment ' + $Number + ' -R ' + $Repo + ' --body-file ' + (Quote-Argument $path))
  if ($result.exitCode -ne 0) { Write-Log ('could not comment on ' + $Kind + ' #' + $Number + ': ' + (Get-ErrorSummary $result)) }
}

function Set-NeedsHuman {
  param([int]$Issue, [int]$Pr, [string]$Reason, [string]$RunDir)
  $entry = Get-IssueEntry $Issue
  Write-Log ('needs-human issue #' + $Issue + ' pr ' + $Pr + ': ' + (ConvertTo-SingleLine $Reason 300))
  Initialize-Label 'needs-human' 'D93F0B' 'An automated run stopped here and a person has to decide'
  Add-GhLabel 'issue' $Issue 'needs-human'
  if ($Pr -gt 0) {
    Add-GhLabel 'pr' $Pr 'needs-human'
    Add-GhComment 'pr' $Pr $Reason $RunDir
  } else {
    Add-GhComment 'issue' $Issue $Reason $RunDir
  }
  $entry['status'] = 'needs-human'
  Save-State
}

function Resolve-TrackingIssue {
  if ($DryRun) { return 0 }
  if ($TrackingIssue -gt 0) { return $TrackingIssue }
  if ($script:ResolvedTrackingIssue -gt 0) { return $script:ResolvedTrackingIssue }
  $cached = [int]$script:State['trackingIssue']
  if ($cached -gt 0) {
    $view = Get-IssueView $cached
    if (-not $view) {
      Write-Log ('could not verify cached tracking issue #' + $cached)
      return 0
    }
    if ([string]$view.state -eq 'OPEN') {
      $script:ResolvedTrackingIssue = $cached
      return $cached
    }
    $script:State['trackingIssue'] = 0
    Save-State
  }

  $title = 'Automated dev loop: progress log'
  $search = Invoke-Gh ('issue list -R ' + $Repo + ' --state open --search ' + (Quote-Argument ($title + ' in:title')) + ' --limit 20 --json number,title')
  if ($search.exitCode -ne 0) {
    Write-Log ('could not search tracking issue: ' + (Get-ErrorSummary $search))
    return 0
  }
  $number = 0
  if (-not [string]::IsNullOrWhiteSpace($search.text)) {
    $items = @($search.text | ConvertFrom-Json | ForEach-Object { $_ })
    $exact = @($items | Where-Object { [string]$_.title -ceq $title } | Sort-Object { [int]$_.number })
    if ($exact.Count -gt 0) { $number = [int]$exact[0].number }
  }
  if ($number -le 0) {
    $body = @(
      'Append-only progress log for the automated dev-loop runner.'
      ''
      '- Entries report automated, agent self-tested results (not maintainer acceptance).'
      '- Issues labelled `needs-human` stopped in automation and require a maintainer decision.'
    ) -join "`n"
    $bodyPath = Join-Path $script:WorkRoot ('tracking-body-' + [Guid]::NewGuid().ToString('N').Substring(0, 8) + '.md')
    Write-Text $bodyPath ($body + "`n")
    $create = Invoke-Gh ('issue create -R ' + $Repo + ' --title ' + (Quote-Argument $title) + ' --body-file ' + (Quote-Argument $bodyPath))
    if ($create.exitCode -ne 0) {
      Write-Log ('could not create tracking issue: ' + (Get-ErrorSummary $create))
      return 0
    }
    $match = [regex]::Match([string]$create.text, '/issues/([0-9]+)')
    if ($match.Success) { $number = [int]$match.Groups[1].Value }
  }
  if ($number -gt 0) {
    $script:State['trackingIssue'] = $number
    $script:ResolvedTrackingIssue = $number
    Save-State
  }
  return $number
}

function Format-TrackingIssueLine {
  param([int]$Number, [string]$Title, [string]$StatusText)
  $cleanTitle = ConvertTo-SingleLine (Protect-PublicText $Title) 140
  $cleanStatus = ConvertTo-SingleLine (Protect-PublicText $StatusText) 300
  if ($cleanTitle) { return ('#' + $Number + ' ' + $cleanTitle + ': ' + $cleanStatus) }
  return ('#' + $Number + ': ' + $cleanStatus)
}

function Add-TrackingComment {
  param([string]$Text, [string]$TempDir)
  if ($DryRun) { Write-Log ('DryRun: tracking: ' + (ConvertTo-SingleLine $Text 300)); return $false }
  try {
    $issueNo = Resolve-TrackingIssue
    if ($issueNo -le 0) { return $false }
    $dir = $TempDir
    if (-not $dir -or -not (Test-Path -LiteralPath $dir -PathType Container)) { $dir = $script:WorkRoot }
    $path = Join-Path $dir ('tracking-' + [Guid]::NewGuid().ToString('N').Substring(0, 8) + '.md')
    $stamp = [DateTime]::Now.ToString('yyyy-MM-ddTHH:mm:ssK')
    $clean = ConvertTo-SingleLine (Protect-PublicText $Text) 500
    Write-Text $path ($stamp + ' ' + $clean + "`n")
    $result = Invoke-Gh ('issue comment ' + $issueNo + ' -R ' + $Repo + ' --body-file ' + (Quote-Argument $path))
    if ($result.exitCode -ne 0) {
      Write-Log ('could not comment on tracking issue #' + $issueNo + ': ' + (Get-ErrorSummary $result))
      return $false
    }
    return $true
  } catch {
    Write-Log ('tracking issue comment failed: ' + $_.Exception.Message)
    return $false
  }
}

function Send-MergeCapNoticeIfNeeded {
  if ($DryRun) { return }
  $today = [DateTime]::Now.ToString('yyyy-MM-dd')
  if ([string]$script:State['mergeCapNotifiedDate'] -eq $today) { return }
  if (Add-TrackingComment ('Daily merge cap (' + $MaxMergesPerDay + ') reached; pausing until tomorrow.') $script:LogsDir) {
    $script:State['mergeCapNotifiedDate'] = $today
    Save-State
  }
}

# ---- worktrees ----

function Add-FinishedTree {
  param([string]$Path, [string]$Branch, [bool]$DeleteBranch)
  $script:FinishedTrees.Add([pscustomobject]@{ path = $Path; branch = $Branch; deleteBranch = $DeleteBranch })
}

function Remove-Worktree {
  param([string]$Path, [string]$Branch, [bool]$DeleteBranch)
  if (Test-Path -LiteralPath $Path) {
    $null = Invoke-Git $script:CheckoutPath ('worktree remove --force ' + (Quote-Argument $Path))
  }
  if (Test-Path -LiteralPath $Path) {
    # Deep node_modules trees can defeat git on Windows; rmdir copes better.
    $null = Invoke-Tool $script:CmdExe ('/d /c rmdir /s /q ' + (Quote-Argument $Path)) (Join-Path $script:WorkRoot '.rmdir.out.tmp') (Join-Path $script:WorkRoot '.rmdir.err.tmp') $script:WorkRoot
  }
  if (Test-Path -LiteralPath $Path) { Write-Log ('could not remove ' + $Path) }
  $null = Invoke-Git $script:CheckoutPath 'worktree prune'
  if ($DeleteBranch -and $Branch) { $null = Invoke-Git $script:CheckoutPath ('branch -D ' + $Branch) }
}

function Find-IssueBranch {
  param([int]$Number)
  $prefix = 'nyx/' + $Number + '-'
  $result = Invoke-Git $script:CheckoutPath ('for-each-ref --format=%(refname:short) "refs/heads/' + $prefix + '*" "refs/remotes/origin/' + $prefix + '*"')
  if ($result.exitCode -ne 0) { return $null }
  $remote = $null
  foreach ($line in @(([string]$result.text) -split "`r?`n")) {
    $name = $line.Trim()
    if (-not $name) { continue }
    if ($name.StartsWith('origin/')) {
      if (-not $remote) { $remote = $name.Substring(7) }
    } else {
      return $name
    }
  }
  return $remote
}

function Test-BranchName {
  param([string]$Branch)
  return ($Branch -match '^nyx/[0-9]+-[A-Za-z0-9._-]*$' -and $Branch -notmatch '\.\.' -and -not $Branch.EndsWith('.lock'))
}

# Reuses the worktree of an earlier attempt; otherwise creates it from an existing local or remote
# branch, or from a new branch cut at origin/main.
function Initialize-Worktree {
  param([string]$Branch, [string]$Path)
  if (-not (Test-BranchName $Branch)) { throw ('unexpected branch name ' + $Branch) }
  if (Test-Path -LiteralPath $Path) {
    $head = Invoke-Git $Path 'rev-parse --abbrev-ref HEAD'
    if ($head.exitCode -eq 0 -and ([string]$head.text).Trim() -eq $Branch) {
      Write-Log ('reusing worktree for ' + $Branch)
      return
    }
    throw 'the work directory for this issue exists but is not a worktree of the expected branch; remove it by hand'
  }
  [IO.Directory]::CreateDirectory((Split-Path -Parent $Path)) | Out-Null
  $local = Invoke-Git $script:CheckoutPath ('rev-parse --verify --quiet "refs/heads/' + $Branch + '"')
  if ($local.exitCode -eq 0) {
    $add = Invoke-Git $script:CheckoutPath ('worktree add ' + (Quote-Argument $Path) + ' ' + $Branch)
  } else {
    $remote = Invoke-Git $script:CheckoutPath ('rev-parse --verify --quiet "refs/remotes/origin/' + $Branch + '"')
    if ($remote.exitCode -eq 0) {
      $add = Invoke-Git $script:CheckoutPath ('worktree add -b ' + $Branch + ' ' + (Quote-Argument $Path) + ' origin/' + $Branch)
    } else {
      $add = Invoke-Git $script:CheckoutPath ('worktree add -b ' + $Branch + ' ' + (Quote-Argument $Path) + ' origin/main')
    }
  }
  if ($add.exitCode -ne 0) { throw ('git worktree add failed: ' + (Get-ErrorSummary $add)) }
}

function Get-RefSha {
  param([string]$Directory, [string]$Ref)
  $result = Invoke-Git $Directory ('rev-parse --verify --quiet "' + $Ref + '"')
  if ($result.exitCode -ne 0 -or [string]::IsNullOrWhiteSpace($result.text)) { return '' }
  return $result.text.Trim()
}

# Creates or reuses the worktree, then brings it level with the PR branch on GitHub: fast-forwards,
# keeps unpushed local commits, and reports a diverged branch as $false.
function Initialize-SyncedWorktree {
  param([string]$Branch, [string]$Path)
  Initialize-Worktree $Branch $Path
  $fetch = Invoke-Git $Path ('fetch origin +refs/heads/' + $Branch + ':refs/remotes/origin/' + $Branch)
  if ($fetch.exitCode -ne 0) { throw ('git fetch of the PR branch failed: ' + (Get-ErrorSummary $fetch)) }
  $remoteHead = Get-RefSha $Path ('refs/remotes/origin/' + $Branch)
  $localHead = Get-RefSha $Path 'HEAD'
  if (-not $remoteHead -or -not $localHead) { throw 'cannot read the branch heads' }
  if ($remoteHead -eq $localHead) { return $true }
  if ((Invoke-Git $Path ('merge-base --is-ancestor ' + $localHead + ' ' + $remoteHead)).exitCode -eq 0) {
    $merge = Invoke-Git $Path ('merge --ff-only ' + $remoteHead)
    if ($merge.exitCode -ne 0) { throw ('cannot fast-forward the worktree: ' + (Get-ErrorSummary $merge)) }
    return $true
  }
  # Local commits that were never pushed (a push that failed earlier) are pushed with the next fix.
  return ((Invoke-Git $Path ('merge-base --is-ancestor ' + $remoteHead + ' ' + $localHead)).exitCode -eq 0)
}

# ---- diff guard and commit ----

function Get-DependencySignature {
  param([string]$Json)
  if ([string]::IsNullOrWhiteSpace($Json)) { return $null }
  try { $data = $Json | ConvertFrom-Json } catch { return $null }
  $parts = @()
  foreach ($section in $script:DependencySections) {
    if ($data.PSObject.Properties[$section]) { $parts += ($section + '=' + (ConvertTo-Json -InputObject $data.$section -Depth 10 -Compress)) }
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

# Stages everything, then judges the whole difference from the merge base, so earlier commits count too.
function Get-DiffGuard {
  param([string]$Worktree)
  $stage = Invoke-Git $Worktree 'add -A'
  if ($stage.exitCode -ne 0) { throw ('git add failed: ' + (Get-ErrorSummary $stage)) }
  $baseResult = Invoke-Git $Worktree 'merge-base origin/main HEAD'
  $base = ''
  if ($baseResult.exitCode -eq 0 -and $baseResult.text) { $base = $baseResult.text.Trim() }
  if (-not $base) { throw 'no merge base between HEAD and origin/main' }
  $names = Invoke-Git $Worktree ('-c core.quotepath=false diff --cached --no-renames --name-only -z ' + $base)
  if ($names.exitCode -ne 0) { throw ('git diff failed: ' + (Get-ErrorSummary $names)) }
  $files = @(([string]$names.text) -split "`0" | Where-Object { $_ })
  $trips = New-Object Collections.Generic.List[string]

  $guarded = @()
  foreach ($file in $files) {
    $normal = $file.Replace('\', '/').ToLowerInvariant()
    $hit = $script:GuardedFiles -contains $normal
    foreach ($prefix in $script:GuardedPrefixes) { if ($normal.StartsWith($prefix)) { $hit = $true } }
    if ($hit) { $guarded += $file }
  }
  if ($guarded.Count -gt 0) {
    $shown = @($guarded | Select-Object -First 8)
    $more = ''
    if ($guarded.Count -gt $shown.Count) { $more = ' and ' + ($guarded.Count - $shown.Count) + ' more' }
    $null = $trips.Add('changes guarded paths: ' + ($shown -join ', ') + $more)
  }
  if ($files -contains 'package.json') {
    $before = Get-DependencySignature (Invoke-Git $Worktree ('show ' + $base + ':package.json')).text
    $after = Get-DependencySignature (Read-Text (Join-Path $Worktree 'package.json'))
    if ($null -eq $before -or $null -eq $after -or $before -ne $after) { $null = $trips.Add('changes the dependencies in package.json') }
  }
  if ($files -contains 'docs/parity.md') {
    $before = Get-ParityStatus (Invoke-Git $Worktree ('show ' + $base + ':docs/parity.md')).text
    $after = Get-ParityStatus (Read-Text (Join-Path $Worktree 'docs\parity.md'))
    foreach ($id in @($after.Keys | Sort-Object)) {
      $wasDone = $before.ContainsKey($id) -and $before[$id] -match '^done\b'
      if ($after[$id] -match '^done\b' -and -not $wasDone) { $null = $trips.Add('sets parity row ' + $id + ' to done') }
    }
  }
  return [pscustomobject]@{ files = $files; trips = @($trips) }
}

function Save-Commit {
  param([string]$Worktree, [string]$Message, [string]$MessagePath)
  $quiet = Invoke-Git $Worktree 'diff --cached --quiet'
  if ($quiet.exitCode -eq 0) { return $false }
  if ($quiet.exitCode -ne 1) { throw ('git diff --cached failed: ' + (Get-ErrorSummary $quiet)) }
  Write-Text $MessagePath $Message
  $commit = Invoke-Git $Worktree ($script:GitIdentity + '-c commit.gpgsign=false commit -q -F ' + (Quote-Argument $MessagePath))
  if ($commit.exitCode -ne 0) { throw ('git commit failed: ' + (Get-ErrorSummary $commit)) }
  return $true
}

# ---- Devin ----

function Invoke-Devin {
  param([string]$RunDir, [string]$Worktree, [string]$PromptPath, [string]$LogPath, [string]$KillTag)
  if ($DevinFrontEnd -eq 'gui') { return (Invoke-DevinGui $RunDir $Worktree $PromptPath $LogPath $KillTag) }
  # A visible console on the signed-in desktop shows Devin's live output; --export keeps the transcript as the log.
  $inner = 'title Devin ' + (Split-Path -Leaf $Worktree) + ' ' + $KillTag + ' && ' +
    (Quote-Argument $script:DevinPath) + ' --model ' + $DevinModel +
    ' --permission-mode dangerous --respect-workspace-trust false --verbosity 2 --prompt-file ' + (Quote-Argument $PromptPath) +
    ' --export ' + (Quote-Argument $LogPath) + ' -p'
  $previous = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  $process = $null
  try {
    $process = Start-Process -FilePath $script:CmdExe -ArgumentList ('/d /c "' + $inner + '"') `
      -WorkingDirectory $Worktree -PassThru -WindowStyle Normal
  } finally {
    $ErrorActionPreference = $previous
  }
  if (-not $process) { throw 'Could not start the Devin CLI.' }
  # The cap also covers the agent's own retries; taskkill ends the whole tree.
  if (-not $process.WaitForExit($DevinTimeoutMin * 60000)) {
    $null = Invoke-Tool (Join-Path ([Environment]::GetFolderPath('System')) 'taskkill.exe') ('/T /F /PID ' + $process.Id) `
      (Join-Path $RunDir ('devin-kill-' + $KillTag + '.out.log')) (Join-Path $RunDir ('devin-kill-' + $KillTag + '.err.log'))
    Stop-WorktreeProcesses $Worktree
    return 'timeout'
  }
  Stop-WorktreeProcesses $Worktree
  return ('exitCode ' + $process.ExitCode)
}

$script:GuiTypesLoaded = $false

function Initialize-GuiTypes {
  if ($script:GuiTypesLoaded) { return }
  Add-Type -AssemblyName System.Windows.Forms
  Add-Type -TypeDefinition @'
using System; using System.Text; using System.Runtime.InteropServices;
public static class DevLoopWindows {
  delegate bool EnumProc(IntPtr h, IntPtr p);
  [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc cb, IntPtr p);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int c);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern void keybd_event(byte k, byte s, uint f, UIntPtr e);
  // Devin Desktop titles a window "<folder> - Devin" or "<session title> <folder> - Devin".
  public static IntPtr Find(string folder) {
    IntPtr found = IntPtr.Zero;
    string bare = folder + " - Devin", tail = " " + bare;
    EnumWindows((h, p) => {
      if (!IsWindowVisible(h)) return true;
      var sb = new StringBuilder(1024); GetWindowText(h, sb, 1024); var t = sb.ToString();
      if (t == bare || t.EndsWith(tail, StringComparison.Ordinal)) { found = h; return false; }
      return true;
    }, IntPtr.Zero);
    return found;
  }
}
'@
  $script:GuiTypesLoaded = $true
}

function Set-DevinForeground {
  param([IntPtr]$Window)
  [DevLoopWindows]::ShowWindow($Window, 9) | Out-Null
  # A tap of Alt lets a background process take the foreground.
  [DevLoopWindows]::keybd_event(0x12, 0, 0, [UIntPtr]::Zero); [DevLoopWindows]::keybd_event(0x12, 0, 2, [UIntPtr]::Zero)
  [DevLoopWindows]::SetForegroundWindow($Window) | Out-Null
  Start-Sleep -Milliseconds 800
  return ([DevLoopWindows]::GetForegroundWindow() -eq $Window)
}

# Devin's agent log records the mode change a /bypass applies; without it the conversation would stop at approvals.
function Wait-DevinBypass {
  param([DateTime]$Since, [int]$Seconds)
  $logs = Join-Path ([Environment]::GetFolderPath('ApplicationData')) 'Devin\cli\logs'
  $deadline = [DateTime]::Now.AddSeconds($Seconds)
  while ([DateTime]::Now -lt $deadline) {
    Start-Sleep -Seconds 2
    $files = @(Get-ChildItem -LiteralPath $logs -Filter 'devin_*.log' -File -ErrorAction SilentlyContinue |
      Where-Object { $_.LastWriteTime -ge $Since })
    foreach ($file in $files) {
      $hit = Select-String -LiteralPath $file.FullName -Pattern 'handle_slash_command_on_chain:apply_mode_change|ModeChange\(Bypass\)' -ErrorAction SilentlyContinue |
        Where-Object { $_.Line -match '^(\S+Z)' -and ([DateTime]::Parse($Matches[1]).ToLocalTime() -ge $Since.AddSeconds(-1)) } |
        Select-Object -First 1
      if ($hit) { return $true }
    }
  }
  return $false
}

function Send-DevinText {
  param([string]$Text)
  [Windows.Forms.Clipboard]::SetText($Text)
  Start-Sleep -Milliseconds 300
  [Windows.Forms.SendKeys]::SendWait('^v')
  Start-Sleep -Milliseconds 800
  [Windows.Forms.SendKeys]::SendWait('{ENTER}')
}

function Send-DevinBypassCommand {
  param([IntPtr]$Window)
  # Explorer first, so Ctrl+L opens the chat rather than toggling an already focused one closed.
  [Windows.Forms.SendKeys]::SendWait('{ESC}^+e')
  Start-Sleep -Seconds 1
  [Windows.Forms.SendKeys]::SendWait('^l')
  Start-Sleep -Seconds 3
  if (-not (Set-DevinForeground $Window)) { return $false }
  [Windows.Forms.SendKeys]::SendWait('^a{DEL}')
  # Text goes through the clipboard: an input method would rewrite typed keys.
  # /bypass lets the agent run every tool without approval prompts in this conversation. The first Enter
  # may only pick the command from the slash menu, so a second one sends it; on an empty box it does nothing.
  $modeSince = [DateTime]::Now
  Send-DevinText '/bypass'
  [Windows.Forms.SendKeys]::SendWait('{ENTER}')
  return (Wait-DevinBypass $modeSince 20)
}

function Read-LogLinesShared {
  param([string]$Path)
  $lines = New-Object Collections.Generic.List[string]
  $stream = $null
  $reader = $null
  try {
    $share = [IO.FileShare]::ReadWrite -bor [IO.FileShare]::Delete
    $stream = New-Object IO.FileStream($Path, [IO.FileMode]::Open, [IO.FileAccess]::Read, $share)
    $reader = New-Object IO.StreamReader($stream, [Text.Encoding]::UTF8, $true)
    while ($null -ne ($line = $reader.ReadLine())) {
      $null = $lines.Add($line)
    }
  } catch {
    return @()
  } finally {
    if ($reader) { $reader.Dispose() }
    elseif ($stream) { $stream.Dispose() }
  }
  return @($lines)
}

# Scans Devin agent logs modified since the prompt was sent to find the latest write time
# and any tool permission prompt still awaiting a decision.
function Get-DevinLogActivity {
  param([DateTime]$SinceUtc)
  $logs = Join-Path ([Environment]::GetFolderPath('ApplicationData')) 'Devin\cli\logs'
  $newestWriteUtc = $null
  $oldestPendingUtc = $null
  if (-not (Test-Path -LiteralPath $logs -PathType Container)) {
    return [pscustomobject]@{ newestWriteUtc = $null; pendingApprovalUtc = $null }
  }
  $files = @(Get-ChildItem -LiteralPath $logs -Filter 'devin_*.log' -File -ErrorAction SilentlyContinue |
    Where-Object { $_.LastWriteTimeUtc -ge $SinceUtc })
  $styles = [Globalization.DateTimeStyles]::AssumeUniversal -bor [Globalization.DateTimeStyles]::AdjustToUniversal
  foreach ($file in $files) {
    if ($null -eq $newestWriteUtc -or $file.LastWriteTimeUtc -gt $newestWriteUtc) {
      $newestWriteUtc = $file.LastWriteTimeUtc
    }
    $filePendingUtc = $null
    foreach ($line in (Read-LogLinesShared $file.FullName)) {
      if ($line -notmatch '^(\S+Z)(?:\s|$)') { continue }
      $parsed = [DateTime]::MinValue
      if (-not [DateTime]::TryParse($Matches[1], [Globalization.CultureInfo]::InvariantCulture, $styles, [ref]$parsed)) { continue }
      if ($parsed -lt $SinceUtc) { continue }
      if ($line -match 'Permission decision for tool \S+: prompting user') {
        $filePendingUtc = $parsed
      } elseif ($null -ne $filePendingUtc -and $line -match 'User approved tool permission|User denied tool permission|auto-decided') {
        $filePendingUtc = $null
      }
    }
    if ($null -ne $filePendingUtc -and ($null -eq $oldestPendingUtc -or $filePendingUtc -lt $oldestPendingUtc)) {
      $oldestPendingUtc = $filePendingUtc
    }
  }
  return [pscustomobject]@{ newestWriteUtc = $newestWriteUtc; pendingApprovalUtc = $oldestPendingUtc }
}

function Invoke-DevinGuiBypassRecovery {
  param([IntPtr]$Window, [string]$Folder)
  $target = $Window
  if (-not (Set-DevinForeground $target)) {
    $refound = [DevLoopWindows]::Find($Folder)
    if ($refound -ne [IntPtr]::Zero) { $target = $refound }
    if (-not (Set-DevinForeground $target)) { return 'window could not be focused' }
  }
  if (Send-DevinBypassCommand $target) { return '/bypass confirmed' }
  return '/bypass not confirmed within 20s'
}

# Opens the worktree in Devin Desktop, switches its chat to /bypass and pastes a short instruction and waits for
# the agent to create a sentinel file as its last action. The session stays in Devin Desktop afterwards.
function Invoke-DevinGui {
  param([string]$RunDir, [string]$Worktree, [string]$PromptPath, [string]$LogPath, [string]$Tag)
  Initialize-GuiTypes
  $sentinel = Join-Path $RunDir ('agent-done-' + $Tag + '.txt')
  Remove-Item -LiteralPath $sentinel -Force -ErrorAction SilentlyContinue
  $message = 'Read the task file ' + $PromptPath + ' and carry it out exactly as written, without asking questions. ' +
    'When you are completely finished, after result.json and pr-body.md, create the empty file ' + $sentinel +
    ' as your very last action.'
  $folder = Split-Path -Leaf $Worktree
  # Not waited on: the launcher may stay attached to the Desktop process it starts.
  $null = Start-Process -FilePath $script:DevinPath -ArgumentList ('desktop ' + (Quote-Argument $Worktree)) -WindowStyle Hidden
  $window = [IntPtr]::Zero
  for ($i = 0; $i -lt 90 -and $window -eq [IntPtr]::Zero; $i++) { Start-Sleep -Seconds 1; $window = [DevLoopWindows]::Find($folder) }
  if ($window -eq [IntPtr]::Zero) { return 'gui: no Devin Desktop window for ' + $folder }
  Start-Sleep -Seconds 8
  $sent = $false
  $sendTimeUtc = [DateTime]::UtcNow
  for ($try = 0; $try -lt 3 -and -not $sent; $try++) {
    if (-not (Set-DevinForeground $window)) { Start-Sleep -Seconds 2; continue }
    if (-not (Send-DevinBypassCommand $window)) { continue }
    if (-not (Set-DevinForeground $window)) { continue }
    [Windows.Forms.SendKeys]::SendWait('^a{DEL}')
    $sendTimeUtc = [DateTime]::UtcNow
    Send-DevinText $message
    $sent = $true
  }
  if (-not $sent) { return 'gui: the Devin Desktop chat did not take /bypass or the window could not be focused' }
  Write-Text $LogPath ('Sent to Devin Desktop window "' + $folder + '" at ' + [DateTime]::Now.ToString('s') + "`n" + $message + "`n" +
    'The conversation is in Devin Desktop; this file is not a transcript.' + "`n")
  $deadline = [DateTime]::UtcNow.AddMinutes($DevinTimeoutMin)
  $recoveries = 0
  $lastRecoveryUtc = [DateTime]::MinValue
  while ([DateTime]::UtcNow -lt $deadline) {
    if (Test-Path -LiteralPath $sentinel) { Start-Sleep -Seconds 10; Stop-WorktreeProcesses $Worktree; return 'exitCode 0' }
    if (Test-Stop) { Stop-WorktreeProcesses $Worktree; return 'stopped' }
    $nowUtc = [DateTime]::UtcNow
    $activity = Get-DevinLogActivity $sendTimeUtc
    $lastWriteUtc = $sendTimeUtc
    if ($null -ne $activity.newestWriteUtc -and $activity.newestWriteUtc -gt $lastWriteUtc) { $lastWriteUtc = $activity.newestWriteUtc }
    $recoveredNow = $false
    if ($null -ne $activity.pendingApprovalUtc) {
      $pendingMinutes = ($nowUtc - $activity.pendingApprovalUtc).TotalMinutes
      if ($recoveries -ge 3 -and $pendingMinutes -gt 10) {
        Write-Log ('Devin GUI stalled (' + $folder + '): pending approval survived ' + $recoveries + ' recoveries for ' + [Math]::Round($pendingMinutes, 1) + 'm')
        Stop-WorktreeProcesses $Worktree
        return 'stalled'
      }
      $sinceRecoveryMin = 9999.0
      if ($lastRecoveryUtc -ne [DateTime]::MinValue) { $sinceRecoveryMin = ($nowUtc - $lastRecoveryUtc).TotalMinutes }
      if ($recoveries -lt 3 -and $pendingMinutes -ge 2 -and $sinceRecoveryMin -ge 2) {
        $recoveries++
        $lastRecoveryUtc = $nowUtc
        $recoveryOutcome = Invoke-DevinGuiBypassRecovery $window $folder
        Write-Log ('Devin GUI stall recovery ' + $recoveries + '/3 (' + $folder + '): pending approval for ' + [Math]::Round($pendingMinutes, 1) + 'm; ' + $recoveryOutcome)
        $recoveredNow = $true
      }
    }
    if (-not $recoveredNow) {
      $idleMinutes = ($nowUtc - $lastWriteUtc).TotalMinutes
      if ($idleMinutes -ge $StallMinutes) {
        Write-Log ('Devin GUI stalled (' + $folder + '): no devin_*.log write for ' + [Math]::Round($idleMinutes, 1) + 'm (limit ' + $StallMinutes + 'm)')
        Stop-WorktreeProcesses $Worktree
        return 'stalled'
      }
      Start-Sleep -Seconds 15
    }
  }
  Stop-WorktreeProcesses $Worktree
  return 'timeout'
}

# App instances the agent's e2e runs leave behind keep the worktree locked and pile up on the desktop.
function Stop-WorktreeProcesses {
  param([string]$Worktree)
  $prefix = $Worktree.TrimEnd('\') + '\'
  Get-Process -ErrorAction SilentlyContinue | Where-Object {
    $path = $null
    try { $path = $_.Path } catch { }
    $path -and $path.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase)
  } | ForEach-Object { try { Stop-Process -Id $_.Id -Force -ErrorAction Stop } catch { } }
}

function Expand-Prompt {
  param([string]$TemplatePath, [hashtable]$Values)
  $template = Read-Text $TemplatePath
  if ($null -eq $template) { throw ((Split-Path -Leaf $TemplatePath) + ' is missing.') }
  $names = (@($Values.Keys | ForEach-Object { [regex]::Escape([string]$_) }) -join '|')
  $map = $Values
  $evaluator = { param($match) [string]$map[$match.Groups[1].Value] }.GetNewClosure()
  # One pass, so a placeholder-like substring inside a substituted value is never rewritten.
  return [regex]::Replace($template, '\{\{(' + $names + ')\}\}', [Text.RegularExpressions.MatchEvaluator]$evaluator)
}

function Read-DevResult {
  param([string]$Path, [DateTime]$NotBefore)
  if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { return $null }
  if ((Get-Item -LiteralPath $Path).LastWriteTimeUtc -lt $NotBefore) { return $null }
  $data = Read-JsonFile $Path
  if ($data -isnot [pscustomobject]) { return $null }
  $status = ''
  $reason = ''
  $title = ''
  if ($data.PSObject.Properties['status']) { $status = ([string]$data.status).Trim().ToLowerInvariant() }
  if ($data.PSObject.Properties['reason']) { $reason = [string]$data.reason }
  if ($data.PSObject.Properties['title']) { $title = ConvertTo-SingleLine ([string]$data.title) 200 }
  if ($status -ne 'ready' -and $status -ne 'blocked') { return $null }
  return [pscustomobject]@{ status = $status; reason = $reason; title = $title }
}

# ---- GitHub reads ----

function Get-GhLogin {
  $login = Invoke-Gh 'api user --jq .login'
  if ($login.exitCode -ne 0 -or [string]::IsNullOrWhiteSpace($login.text)) { throw ('gh cannot tell who is signed in: ' + (Get-ErrorSummary $login)) }
  return $login.text.Trim()
}

function Get-OpenPrs {
  $result = Invoke-Gh ('pr list -R ' + $Repo + ' --state open --limit 1000 --json number,headRefName,headRefOid,isDraft,isCrossRepository,baseRefName,labels,author,title')
  if ($result.exitCode -ne 0) { throw ('gh pr list failed: ' + (Get-ErrorSummary $result)) }
  if ([string]::IsNullOrWhiteSpace($result.text)) { return @() }
  # Windows PowerShell 5.1 emits a JSON array as one Object[]; unroll it.
  return @($result.text | ConvertFrom-Json | ForEach-Object { $_ })
}

# Piping $null into ForEach-Object still runs the block once, so absent lists are caught first.
function Get-LabelNames {
  param($Labels)
  if ($null -eq $Labels) { return @() }
  return @($Labels | ForEach-Object { [string]$_.name })
}

function ConvertTo-StringList {
  param($Value)
  if ($null -eq $Value) { return @() }
  return @($Value | ForEach-Object { [string]$_ } | Where-Object { $_ })
}

function Get-PrInfo {
  param([int]$Number)
  $result = Invoke-Gh ('pr view ' + $Number + ' -R ' + $Repo + ' --json state,headRefOid,headRefName,isDraft,isCrossRepository,mergeable,labels,title,body,author,baseRefName')
  if ($result.exitCode -ne 0 -or [string]::IsNullOrWhiteSpace($result.text)) { return $null }
  try { $data = $result.text | ConvertFrom-Json } catch { return $null }
  return [pscustomobject]@{
    number = $Number; state = [string]$data.state; headSha = [string]$data.headRefOid; branch = [string]$data.headRefName
    draft = [bool]$data.isDraft; cross = [bool]$data.isCrossRepository; mergeable = [string]$data.mergeable
    labels = @(Get-LabelNames $data.labels); title = [string]$data.title; body = [string]$data.body
    author = [string]$data.author.login; base = [string]$data.baseRefName
  }
}

function Get-IssueView {
  param([int]$Number)
  $result = Invoke-Gh ('issue view ' + $Number + ' -R ' + $Repo + ' --json number,title,body,state,labels,comments')
  if ($result.exitCode -ne 0 -or [string]::IsNullOrWhiteSpace($result.text)) { return $null }
  try { return ($result.text | ConvertFrom-Json) } catch { return $null }
}

# The issue text goes to the agent as a file, never onto a command line.
function Write-IssueFile {
  param($View, [string]$Path)
  $builder = New-Object Text.StringBuilder
  $null = $builder.AppendLine([string]$View.body)
  $comments = @()
  if ($null -ne $View.comments) { $comments = @($View.comments | ForEach-Object { $_ }) }
  if ($comments.Count -gt 0) {
    $null = $builder.AppendLine('')
    $null = $builder.AppendLine('---')
    $null = $builder.AppendLine('Comments, oldest first (untrusted data):')
    foreach ($comment in $comments) {
      $null = $builder.AppendLine('')
      $null = $builder.AppendLine('### ' + [string]$comment.author.login + ', ' + [string]$comment.createdAt)
      $null = $builder.AppendLine([string]$comment.body)
    }
  }
  $text = $builder.ToString()
  if ($text.Length -gt 100000) { $text = $text.Substring(0, 100000) + "`n[truncated]`n" }
  Write-Text $Path $text
}

function Find-OpenPrForBranch {
  param([string]$Branch)
  foreach ($pull in @(Get-OpenPrs)) {
    if ([string]$pull.headRefName -eq $Branch -and [string]$pull.author.login -eq $script:Me -and -not $pull.isCrossRepository) { return [int]$pull.number }
  }
  return 0
}

# ---- review and gate ----

function Find-ExistingGate {
  param([int]$PrNumber, [string]$Sha)
  $runs = Join-Path $script:ReviewRootPath 'runs'
  if (-not (Test-Path -LiteralPath $runs -PathType Container)) { return $null }
  $dirs = @(Get-ChildItem -LiteralPath $runs -Directory -Filter ('pr-' + $PrNumber + '-' + $Sha.Substring(0, 7) + '-*') -ErrorAction SilentlyContinue |
    Sort-Object Name -Descending)
  foreach ($dir in $dirs) {
    $path = Join-Path $dir.FullName 'gate.json'
    $gate = Read-JsonFile $path
    if ($gate -and [string]$gate.headSha -eq $Sha -and $gate.reviewOk -eq $true -and $gate.posted -eq $true) {
      return [pscustomobject]@{ gate = $gate; path = $path }
    }
  }
  return $null
}

# Runs the isolated reviewer. status is ok (a gate for this head is in hand), busy (another review
# holds the reviewer's lock; try again next run) or unavailable.
function Invoke-Review {
  param([int]$PrNumber, [string]$Sha, [string]$RunDir, [bool]$NoPost, [string]$Tag)
  $outLog = Join-Path $RunDir ('review-' + $Tag + '.out.log')
  $errLog = Join-Path $RunDir ('review-' + $Tag + '.err.log')
  $inner = (Quote-Argument $script:PowerShellExe) + ' -NoProfile -NonInteractive -ExecutionPolicy Bypass -File ' + (Quote-Argument $script:ReviewScript) +
    ' -Repo ' + $Repo + ' -Root ' + (Quote-Argument $script:ReviewRootPath) + ' -Checkout ' + (Quote-Argument $script:ReviewCheckoutPath) +
    ' -StandardCredentialFile ' + (Quote-Argument $script:CredentialPath) + ' -DevinModel ' + $DevinModel +
    ' -PrNumber ' + $PrNumber + ' -Force'
  if ($script:ReviewTokenPath) { $inner += ' -TokenFile ' + (Quote-Argument $script:ReviewTokenPath) }
  if ($script:ReferencePath) { $inner += ' -Reference ' + (Quote-Argument $script:ReferencePath) }
  if ($NoPost) { $inner += ' -DryRun' }
  $inner += ' > ' + (Quote-Argument $outLog) + ' 2> ' + (Quote-Argument $errLog)
  Write-Log ('review pr #' + $PrNumber + ' head ' + $Sha.Substring(0, 7) + ' (' + $Tag + ')')
  $process = Start-Process -FilePath $script:CmdExe -ArgumentList ('/d /c "' + $inner + '"') `
    -WorkingDirectory $script:WorkRoot -PassThru -WindowStyle Hidden
  if (-not $process) { throw 'Could not start Invoke-PrReview.ps1.' }
  if (-not $process.WaitForExit($script:ReviewTimeoutMin * 60000)) {
    $null = Invoke-Tool (Join-Path ([Environment]::GetFolderPath('System')) 'taskkill.exe') ('/T /F /PID ' + $process.Id) `
      (Join-Path $RunDir ('review-kill-' + $Tag + '.out.log')) (Join-Path $RunDir ('review-kill-' + $Tag + '.err.log'))
    return [pscustomobject]@{ status = 'unavailable'; message = 'the review run timed out'; gate = $null; gatePath = $null }
  }

  $summary = $null
  try { $summary = (Get-Tail $outLog 1) | ConvertFrom-Json } catch { }
  if (-not $summary) {
    return [pscustomobject]@{ status = 'unavailable'; message = 'the review run printed no summary'; gate = $null; gatePath = $null }
  }
  $skippedList = @()
  if ($null -ne $summary.skipped) { $skippedList = @($summary.skipped | ForEach-Object { $_ }) }
  $reviewedList = @()
  if ($null -ne $summary.reviewed) { $reviewedList = @($summary.reviewed | ForEach-Object { $_ }) }
  $errorList = @()
  if ($null -ne $summary.errors) { $errorList = @($summary.errors | ForEach-Object { $_ }) }
  foreach ($skipped in $skippedList) {
    if ($null -eq $skipped.pr -and [string]$skipped.reason -like '*lock*') {
      return [pscustomobject]@{ status = 'busy'; message = 'another review holds the reviewer lock'; gate = $null; gatePath = $null }
    }
  }
  $gatePath = $null
  $message = ''
  foreach ($entry in $reviewedList) {
    if ([int]$entry.pr -eq $PrNumber -and $entry.PSObject.Properties['gatePath']) { $gatePath = [string]$entry.gatePath }
  }
  if (-not $gatePath) {
    foreach ($entry in $errorList) {
      if ($null -ne $entry.pr -and [int]$entry.pr -ne $PrNumber) { continue }
      $message = [string]$entry.error
      if ($null -ne $entry.pr -and $entry.PSObject.Properties['gatePath']) { $gatePath = [string]$entry.gatePath }
    }
  }
  if (-not $gatePath) {
    foreach ($skipped in $skippedList) {
      if ($null -ne $skipped.pr -and [int]$skipped.pr -eq $PrNumber) { $message = [string]$skipped.reason }
    }
    if (-not $message) { $message = 'the review run reported no result for this PR' }
    return [pscustomobject]@{ status = 'unavailable'; message = $message; gate = $null; gatePath = $null }
  }
  $gate = Read-JsonFile $gatePath
  if (-not $gate -or [string]$gate.headSha -ne $Sha) {
    return [pscustomobject]@{ status = 'unavailable'; message = 'gate.json is missing or is for another head'; gate = $null; gatePath = $null }
  }
  return [pscustomobject]@{ status = 'ok'; message = $message; gate = $gate; gatePath = $gatePath }
}

function Format-Step {
  param($Value)
  if ($null -eq $Value) { return 'not run' }
  return [string]$Value
}

# Splits what is wrong into infra (the review machinery failed; a fix cannot help) and content
# (the PR itself failed a gate condition).
function Test-GateResult {
  param($Gate, [bool]$RequirePosted)
  $infra = New-Object Collections.Generic.List[string]
  $content = New-Object Collections.Generic.List[string]
  $other = New-Object Collections.Generic.List[string]
  $newFailures = @(ConvertTo-StringList $Gate.newFailures)

  if ($Gate.reviewOk -ne $true) { $null = $infra.Add('the reviewer did not produce a usable review') }
  elseif ($null -eq $Gate.verdict) { $null = $infra.Add('the reviewer wrote no usable verdict.json') }
  if ($RequirePosted -and $Gate.posted -ne $true) { $null = $infra.Add('the review comment was not posted') }
  $prSteps = $Gate.pr
  $baseSteps = $Gate.base
  if ($null -eq $prSteps -or $null -eq $prSteps.install) { $null = $infra.Add('the pr checks produced no results') }
  if ($null -eq $baseSteps -or $null -eq $baseSteps.install) { $null = $infra.Add('the base checks produced no results') }

  if ($null -ne $prSteps -and $null -ne $prSteps.install) {
    if ([int]$prSteps.install -ne 0) {
      $text = 'pr install exit ' + $prSteps.install
      $null = $content.Add($text); $null = $other.Add($text)
    } elseif ($null -eq $prSteps.build -or [int]$prSteps.build -ne 0) {
      $text = 'pr build exit ' + (Format-Step $prSteps.build)
      $null = $content.Add($text); $null = $other.Add($text)
    } else {
      if ($null -eq $prSteps.typecheck -or [int]$prSteps.typecheck -ne 0) {
        $text = 'pr typecheck exit ' + (Format-Step $prSteps.typecheck)
        $null = $content.Add($text); $null = $other.Add($text)
      }
      $baseUnitFailing = $null -ne $baseSteps -and $null -ne $baseSteps.unit -and [int]$baseSteps.unit -ne 0
      if ($null -eq $prSteps.unit) {
        $text = 'pr unit tests did not run'
        $null = $content.Add($text); $null = $other.Add($text)
      } elseif ([int]$prSteps.unit -ne 0) {
        # A failing suite is tolerated only when base fails too and no test newly fails; a suite that
        # cannot even be collected has no per-test results to compare.
        if (-not ($baseUnitFailing -and $Gate.unitComparison -eq $true -and $newFailures.Count -eq 0)) {
          $null = $content.Add('pr unit exit ' + $prSteps.unit)   # flake-related: not added to $other
        }
      }
      $baseE2eFailing = $null -ne $baseSteps -and $null -ne $baseSteps.e2e -and [int]$baseSteps.e2e -ne 0
      if ($null -eq $prSteps.e2e) {
        $text = 'pr e2e did not run'
        $null = $content.Add($text); $null = $other.Add($text)
      } elseif ([int]$prSteps.e2e -ne 0) {
        # Not worse than base: both fail, and a timeout (124) on the pr side needs a timeout on base.
        $worse = -not $baseE2eFailing -or (([int]$prSteps.e2e -eq 124) -ne ([int]$baseSteps.e2e -eq 124))
        if ($worse) {
          $text = 'pr e2e exit ' + $prSteps.e2e + ' (base ' + (Format-Step $baseSteps.e2e) + ')'
          $null = $content.Add($text); $null = $other.Add($text)
        }
      }
    }
  }
  if ($newFailures.Count -gt 0) { $null = $content.Add(([string]$newFailures.Count) + ' unit test(s) fail on the pr and pass on base') }

  if ($null -ne $Gate.verdict) {
    $blocking = @(ConvertTo-StringList $Gate.verdict.blocking)
    $recommendation = [string]$Gate.verdict.recommendation
    if ($recommendation -ne 'merge') { $null = $content.Add('the reviewer recommends changes') }
    elseif ($blocking.Count -gt 0) { $null = $content.Add('the reviewer says merge but lists blocking points') }
    $shown = 0
    foreach ($point in $blocking) {
      if ($shown -ge 20) { break }
      $null = $content.Add('blocking: ' + $point)
      $shown++
    }
  }
  # Only unit failures and what the reviewer made of them: those can be a flake worth one re-run.
  $flakeCandidate = ($infra.Count -eq 0 -and $other.Count -eq 0 -and $newFailures.Count -gt 0)
  return [pscustomobject]@{ infra = @($infra); content = @($content); newFailures = $newFailures; flakeCandidate = $flakeCandidate }
}

function Write-GateFailures {
  param([string]$Path, $Evaluation, [string[]]$Extra, [string]$Sha)
  $lines = New-Object Collections.Generic.List[string]
  $null = $lines.Add('# Merge gate failures')
  $null = $lines.Add('')
  $null = $lines.Add('These conditions failed for head ' + $Sha.Substring(0, 7) + '. Fix every one of them.')
  $null = $lines.Add('')
  foreach ($item in @($Extra) + @($Evaluation.content)) { if ($item) { $null = $lines.Add('- ' + $item) } }
  if ($Evaluation.newFailures.Count -gt 0) {
    $null = $lines.Add('')
    $null = $lines.Add('## New failing unit tests')
    $null = $lines.Add('')
    foreach ($name in @($Evaluation.newFailures | Select-Object -First 50)) { $null = $lines.Add('- ' + $name) }
  }
  Write-Text $Path (($lines -join "`n") + "`n")
}

# ---- PR pipeline ----

function Invoke-MergeStep {
  param([int]$Pr, [string]$Sha)
  if ((Get-MergesToday) -ge $MaxMergesPerDay) { return [pscustomobject]@{ result = 'cap'; message = 'the daily merge limit is reached' } }
  $live = Get-PrInfo $Pr
  if (-not $live -or $live.state -ne 'OPEN' -or $live.headSha -ne $Sha) {
    return [pscustomobject]@{ result = 'changed'; message = 'the PR changed while it was being judged' }
  }
  $merge = Invoke-Gh ('pr merge ' + $Pr + ' -R ' + $Repo + ' --squash --match-head-commit ' + $Sha + ' --delete-branch')
  if ($merge.exitCode -ne 0) {
    # The merge can succeed and the branch deletion fail; look before calling it a failure.
    $after = Get-PrInfo $Pr
    if (-not $after -or $after.state -ne 'MERGED') {
      return [pscustomobject]@{ result = 'failed'; message = (Get-ErrorSummary $merge) }
    }
  }
  Add-MergeToday
  return [pscustomobject]@{ result = 'merged'; message = '' }
}

function Invoke-FixRound {
  param([int]$Issue, [int]$Pr, [string]$Branch, [string]$Worktree, [string]$RunDir, $Info, [int]$Round, $Evaluation, $Review, [string]$FailuresPath)
  if (-not (Test-Path -LiteralPath $script:FixPrompt -PathType Leaf)) { throw 'fix-prompt.md is missing.' }
  if (-not (Initialize-SyncedWorktree $Branch $Worktree)) {
    return [pscustomobject]@{ result = 'needs-human'; message = 'the local branch and the PR branch have diverged' }
  }
  $view = Get-IssueView $Issue
  if (-not $view) { throw 'cannot read the issue' }
  $issueFile = Join-Path $RunDir ('issue-fix' + $Round + '.md')
  Write-IssueFile $view $issueFile

  $resultPath = Join-Path $RunDir 'result.json'
  $bodyPath = Join-Path $RunDir 'pr-body.md'
  $bodyBefore = ([string]$Info.body).Replace("`r`n", "`n").TrimEnd()
  Write-Text (Join-Path $RunDir ('pr-body.before-fix' + $Round + '.md')) $Info.body
  Write-Text $resultPath ((ConvertTo-Json -InputObject ([ordered]@{ status = 'ready'; reason = ''; title = $Info.title }) -Compress) + "`n")
  Write-Text $bodyPath $Info.body

  $reviewDir = Split-Path -Parent $Review.gatePath
  $referenceText = 'not available'
  if ($script:ReferencePath) { $referenceText = $script:ReferencePath }
  $prompt = Expand-Prompt $script:FixPrompt @{
    REPO = $Repo; PR = [string]$Pr; ROUND = [string]$Round; ISSUE = [string]$Issue
    ISSUE_TITLE = (ConvertTo-SingleLine ([string]$view.title) 200); ISSUE_BODY_FILE = $issueFile
    WORKTREE = $Worktree; RUN = $RunDir; REFERENCE = $referenceText
    REVIEW_FILE = (Join-Path $reviewDir 'review.md'); GATE_FILE = $Review.gatePath
    CHECKS_SUMMARY_FILE = (Join-Path $reviewDir 'checks-summary.md'); FAILURES_FILE = $FailuresPath
  }
  $promptPath = Join-Path $RunDir ('fix-prompt-' + $Round + '.md')
  Write-Text $promptPath $prompt

  $agentStart = [DateTime]::UtcNow
  $devin = Invoke-Devin $RunDir $Worktree $promptPath (Join-Path $RunDir ('devin-fix-' + $Round + '.log')) ('fix' + $Round)
  if ($devin -eq 'stopped') { return [pscustomobject]@{ result = 'stopped'; message = 'STOP file present' } }
  if ($devin -ne 'exitCode 0') { return [pscustomobject]@{ result = 'failed'; message = 'Devin CLI ' + $devin } }
  $result = Read-DevResult $resultPath $agentStart
  if (-not $result) { return [pscustomobject]@{ result = 'failed'; message = 'the agent did not update result.json' } }
  if ($result.status -eq 'blocked') {
    return [pscustomobject]@{ result = 'needs-human'; message = ('The agent could not fix the review points unattended: ' + $result.reason) }
  }

  $guard = Get-DiffGuard $Worktree
  if ($guard.trips.Count -gt 0) {
    return [pscustomobject]@{ result = 'needs-human'; message = ('The fix was not pushed because it ' + ($guard.trips -join '; ') + '. The branch is unchanged on GitHub.') }
  }
  $messagePath = Join-Path $RunDir ('commit-fix' + $Round + '.txt')
  $subject = 'Address review feedback (round ' + $Round + ')'
  $null = Save-Commit $Worktree ($subject + "`n`n" + 'Implemented by an AI coding agent (Devin); agent self-tested.' + "`n") $messagePath
  # The agent may have made a merge commit itself (merging origin/main), so compare heads rather than trust $committed.
  $pushed = (Get-RefSha $Worktree 'HEAD') -ne (Get-RefSha $Worktree ('refs/remotes/origin/' + $Branch))
  if ($pushed) {
    $push = Invoke-Git $Worktree ('push origin ' + $Branch)
    if ($push.exitCode -ne 0) { return [pscustomobject]@{ result = 'failed'; message = 'git push failed: ' + (Get-ErrorSummary $push) } }
  }
  $bodyAfter = (Read-Text $bodyPath)
  $bodyChanged = $false
  if ($bodyAfter -and -not [string]::IsNullOrWhiteSpace($bodyAfter) -and $bodyAfter.Replace("`r`n", "`n").TrimEnd() -ne $bodyBefore) {
    $bodyChanged = $true
    Update-PrBody $Pr $Issue $bodyAfter $RunDir
  }
  if (-not $pushed -and -not $bodyChanged) {
    return [pscustomobject]@{ result = 'needs-human'; message = ('The agent made no change for the review points. Its note: ' + $result.reason) }
  }
  return [pscustomobject]@{ result = 'fixed'; message = '' }
}

function Update-PrBody {
  param([int]$Pr, [int]$Issue, [string]$Body, [string]$RunDir)
  $text = Protect-PublicText $Body
  if ($text -notmatch ('(?i)closes\s+#' + $Issue + '\b')) { $text = $text.TrimEnd() + "`n`nCloses #" + $Issue + "`n" }
  $path = Join-Path $RunDir 'pr-body.publish.md'
  Write-Text $path $text
  $edit = Invoke-Gh ('pr edit ' + $Pr + ' -R ' + $Repo + ' --body-file ' + (Quote-Argument $path))
  if ($edit.exitCode -ne 0) { Write-Log ('could not update the PR body: ' + (Get-ErrorSummary $edit)) }
}

function Register-ReviewFailure {
  param([int]$Issue, [int]$Pr, [string]$Why, [string]$RunDir)
  $entry = Get-IssueEntry $Issue
  $failures = [int]$entry['reviewFailures'] + 1
  $entry['reviewFailures'] = $failures
  Save-State
  Write-Log ('review unusable (' + $failures + '): ' + $Why)
  if ($failures -ge 2) {
    $script:LastUnitDetail = 'review failed twice: ' + (ConvertTo-SingleLine $Why 160)
    Set-NeedsHuman $Issue $Pr ('The automated review could not be completed twice in a row (' + $Why + '). Leaving the PR open for a person.') $RunDir
    return 'needs-human'
  }
  $script:LastUnitDetail = 'review unavailable: ' + (ConvertTo-SingleLine $Why 160)
  return 'deferred'
}

# Judge, fix, repeat. Returns one of merged, closed, needs-human, deferred, stopped.
function Invoke-PrPipeline {
  param([int]$Issue, [int]$Pr, [string]$Branch, [string]$RunDir)
  $script:LastUnitDetail = ''
  $entry = Get-IssueEntry $Issue
  $entry['pr'] = $Pr
  $entry['branch'] = $Branch
  $entry['lastRunDir'] = $RunDir
  $worktree = Join-Path $script:WorkRoot ('work\issue-' + $Issue)
  Save-State
  $freshReview = $false

  while ($true) {
    if (Test-Stop) { $script:LastUnitDetail = 'STOP file present'; return 'stopped' }
    $info = Get-PrInfo $Pr
    if (-not $info) { throw ('cannot read PR #' + $Pr) }
    if ($info.state -eq 'MERGED') {
      $entry['status'] = 'merged'
      Save-State
      Add-FinishedTree $worktree $Branch $true
      $script:LastUnitDetail = 'already merged'
      return 'merged'
    }
    if ($info.state -ne 'OPEN') {
      # A person closed it. Do not redo the work behind their back.
      $script:LastUnitDetail = 'PR #' + $Pr + ' was closed without merging'
      Set-NeedsHuman $Issue 0 ('PR #' + $Pr + ' was closed without merging, so the runner will not take this issue again until someone decides.') $RunDir
      $entry['status'] = 'needs-human'
      Save-State
      Add-FinishedTree $worktree $Branch $false
      return 'closed'
    }
    if ($info.branch -ne $Branch -or $info.author -ne $script:Me -or $info.cross -or $info.base -ne 'main' -or -not $info.branch.StartsWith('nyx/')) {
      throw ('PR #' + $Pr + ' is not one of this runner''s nyx/ pull requests')
    }
    if ($info.labels -contains 'needs-human') { $script:LastUnitDetail = 'PR #' + $Pr + ' is labelled needs-human'; return 'needs-human' }
    if ($info.draft) { Write-Log ('PR #' + $Pr + ' is a draft; left alone'); $script:LastUnitDetail = 'PR #' + $Pr + ' is a draft'; return 'deferred' }
    $sha = $info.headSha
    $entry['status'] = 'in-pr'

    # The final gate for a head is kept, so a deferred merge or a failed fix round does not trigger a second review.
    $skipKnown = $freshReview
    $freshReview = $false
    $review = $null
    $evaluation = $null
    $flakeNames = @()
    if (-not $skipKnown -and $entry['gateHead'] -eq $sha -and $entry['gatePath']) {
      $gate = Read-JsonFile ([string]$entry['gatePath'])
      if ($gate -and [string]$gate.headSha -eq $sha) {
        $review = [pscustomobject]@{ status = 'ok'; gate = $gate; gatePath = [string]$entry['gatePath'] }
        $evaluation = Test-GateResult $gate $false
        $flakeNames = @(ConvertTo-StringList $entry['flakeNames'])
      }
    }
    if (-not $review) {
      $existing = $null
      if (-not $skipKnown) { $existing = Find-ExistingGate $Pr $sha }
      if ($existing) {
        Write-Log ('using the existing review gate for head ' + $sha.Substring(0, 7))
        $review = [pscustomobject]@{ status = 'ok'; gate = $existing.gate; gatePath = $existing.path }
      } else {
        $review = Invoke-Review $Pr $sha $RunDir $false ('r' + [int]$entry['fixRounds'] + 'a')
      }
      if ($review.status -eq 'busy') { Write-Log 'the reviewer is busy; will retry next run'; $script:LastUnitDetail = 'reviewer is busy'; return 'deferred' }
      if ($review.status -ne 'ok') { return (Register-ReviewFailure $Issue $Pr $review.message $RunDir) }
      $evaluation = Test-GateResult $review.gate $true
      if ($evaluation.infra.Count -eq 0 -and $evaluation.content.Count -gt 0 -and $evaluation.flakeCandidate) {
        # Only unit failures are in the way: run the review once more, without a second comment, to rule out a flake.
        Write-Log 'only new unit failures; re-running the review once to rule out a flake'
        $flakeNames = @($evaluation.newFailures)
        $second = Invoke-Review $Pr $sha $RunDir $true ('r' + [int]$entry['fixRounds'] + 'b')
        if ($second.status -eq 'busy') { $script:LastUnitDetail = 'reviewer is busy'; return 'deferred' }
        if ($second.status -ne 'ok') { return (Register-ReviewFailure $Issue $Pr $second.message $RunDir) }
        $review = $second
        $evaluation = Test-GateResult $second.gate $false
      }
    }
    if ($evaluation.infra.Count -gt 0) { return (Register-ReviewFailure $Issue $Pr ($evaluation.infra -join '; ') $RunDir) }
    $entry['reviewFailures'] = 0
    $entry['gateHead'] = $sha
    $entry['gatePath'] = $review.gatePath
    $entry['flakeNames'] = @($flakeNames)
    Save-State

    $extra = @()
    if ($info.mergeable -eq 'CONFLICTING') { $extra += 'the PR conflicts with main; merge origin/main into the branch and resolve the conflicts' }
    if ($evaluation.content.Count -eq 0 -and $extra.Count -eq 0) {
      $merge = Invoke-MergeStep $Pr $sha
      if ($merge.result -eq 'merged') {
        Write-Log ('merged PR #' + $Pr)
        if ($flakeNames.Count -gt 0) {
          $listed = @($flakeNames | Select-Object -First 10) -join '; '
          Add-GhComment 'pr' $Pr ('The first review run reported failing unit tests that passed on base (' + $listed + '). They did not fail in a second run of the checks on the same head, so they were treated as flaky and the PR was merged.') $RunDir
        }
        $entry['status'] = 'merged'
        $entry['mergeFailures'] = 0
        Save-State
        Add-FinishedTree $worktree $Branch $true
        $script:LastUnitDetail = 'merged'
        return 'merged'
      }
      if ($merge.result -eq 'cap') { Write-Log $merge.message; $script:LastUnitDetail = 'daily merge cap reached'; return 'deferred' }
      if ($merge.result -eq 'changed') { continue }
      $failures = [int]$entry['mergeFailures'] + 1
      $entry['mergeFailures'] = $failures
      Save-State
      Write-Log ('merge failed (' + $failures + '): ' + $merge.message)
      if ($failures -ge 3) {
        $script:LastUnitDetail = 'merge failed 3 times: ' + (ConvertTo-SingleLine $merge.message 160)
        Set-NeedsHuman $Issue $Pr ('The merge failed three times: ' + $merge.message) $RunDir
        return 'needs-human'
      }
      $script:LastUnitDetail = 'merge failed (' + $failures + '/3): ' + (ConvertTo-SingleLine $merge.message 140)
      return 'deferred'
    }

    # The gate failed on content: use a fix round, or hand over.
    $round = [int]$entry['fixRounds'] + 1
    $failuresPath = Join-Path $RunDir ('gate-failures-' + $round + '.md')
    Write-GateFailures $failuresPath $evaluation $extra $sha
    if ([int]$entry['fixRounds'] -ge $MaxFixRounds) {
      $summary = @($extra) + @($evaluation.content)
      $listed = (@($summary | Select-Object -First 8) | ForEach-Object { '- ' + $_ }) -join "`n"
      $script:LastUnitDetail = 'merge gate still fails after ' + $MaxFixRounds + ' fix round(s)'
      Set-NeedsHuman $Issue $Pr ('The merge gate still fails for head ' + $sha.Substring(0, 7) + ' after ' + $MaxFixRounds + ' fix round(s):' + "`n`n" + $listed) $RunDir
      return 'needs-human'
    }
    if (Test-Stop) { $script:LastUnitDetail = 'STOP file present'; return 'stopped' }
    $entry['fixRounds'] = $round
    Save-State
    Write-Log ('fix round ' + $round + ' for PR #' + $Pr)
    $fix = Invoke-FixRound $Issue $Pr $Branch $worktree $RunDir $info $round $evaluation $review $failuresPath
    if ($fix.result -eq 'fixed') {
      # A fix that only changed the PR text leaves the head as it was; the next review must still run.
      $entry['gateHead'] = $null
      $entry['gatePath'] = $null
      $freshReview = $true
      Save-State
      continue
    }
    if ($fix.result -eq 'stopped') {
      $script:LastUnitDetail = $fix.message
      return 'stopped'
    }
    if ($fix.result -eq 'needs-human') {
      $script:LastUnitDetail = ConvertTo-SingleLine $fix.message 200
      Set-NeedsHuman $Issue $Pr $fix.message $RunDir
      return 'needs-human'
    }
    Write-Log ('fix round ' + $round + ' failed: ' + $fix.message)
    $script:LastUnitDetail = 'fix round ' + $round + ' failed (' + (ConvertTo-SingleLine $fix.message 140) + ')'
    return 'deferred'
  }
}

# ---- one issue, from issue text to a merged PR ----

function Invoke-IssueUnit {
  param($Issue)
  $script:LastUnitTitle = ''
  $script:LastUnitDetail = ''
  $number = [int]$Issue.number
  $entry = Get-IssueEntry $number
  $stamp = [DateTime]::Now.ToString('yyyyMMddTHHmmss')
  $runDir = Join-Path $script:RunsDir ('issue-' + $number + '-' + $stamp)
  [IO.Directory]::CreateDirectory($runDir) | Out-Null
  $entry['lastRunDir'] = $runDir
  Write-Log ('issue #' + $number + ': start, run ' + (Split-Path -Leaf $runDir))

  $view = Get-IssueView $number
  if (-not $view) { throw ('cannot read issue #' + $number) }
  $title = ConvertTo-SingleLine ([string]$view.title) 200
  $script:LastUnitTitle = $title
  if ([string]$view.state -ne 'OPEN') {
    Write-Log ('issue #' + $number + ' is not open')
    $script:LastUnitDetail = 'issue is not open (state ' + [string]$view.state + ')'
    return 'skipped'
  }
  $entry['skipNotified'] = $false
  $issueFile = Join-Path $runDir 'issue.md'
  Write-IssueFile $view $issueFile

  # Counted before any local work so a crash counts too; restored below once the attempt has a clean outcome.
  $previousAttempts = [int]$entry['attempts']
  $entry['attempts'] = $previousAttempts + 1
  $entry['status'] = 'developing'
  Save-State

  $branch = Find-IssueBranch $number
  if (-not $branch) { $branch = 'nyx/' + $number + '-' + (ConvertTo-Slug $title) }
  $worktree = Join-Path $script:WorkRoot ('work\issue-' + $number)
  Initialize-Worktree $branch $worktree
  $entry['branch'] = $branch
  Save-State

  $referenceText = 'not available'
  if ($script:ReferencePath) { $referenceText = $script:ReferencePath }
  $prompt = Expand-Prompt $script:DevPrompt @{
    REPO = $Repo; ISSUE = [string]$number; ISSUE_TITLE = $title; ISSUE_BODY_FILE = $issueFile
    WORKTREE = $worktree; RUN = $runDir; REFERENCE = $referenceText
  }
  $promptPath = Join-Path $runDir 'dev-prompt.md'
  Write-Text $promptPath $prompt

  $resultPath = Join-Path $runDir 'result.json'
  $bodyPath = Join-Path $runDir 'pr-body.md'
  $agentStart = [DateTime]::UtcNow
  $devin = Invoke-Devin $runDir $worktree $promptPath (Join-Path $runDir 'devin-dev.log') 'dev'
  if ($devin -eq 'stopped') {
    Write-Log ('issue #' + $number + ': stopped by STOP file; restoring attempt count')
    $entry['attempts'] = $previousAttempts
    $entry['status'] = 'stopped'
    Save-State
    $script:LastUnitDetail = 'STOP file present'
    return 'stopped'
  }
  if ($devin -ne 'exitCode 0') {
    Write-Log ('issue #' + $number + ': Devin CLI ' + $devin + '; worktree kept, attempt ' + $entry['attempts'])
    $entry['status'] = 'failed'
    Save-State
    $script:LastUnitDetail = $devin
    return 'failed'
  }
  $result = Read-DevResult $resultPath $agentStart
  if (-not $result) {
    Write-Log ('issue #' + $number + ': no usable result.json; worktree kept, attempt ' + $entry['attempts'])
    $entry['status'] = 'failed'
    Save-State
    $script:LastUnitDetail = 'no usable result.json'
    return 'failed'
  }

  if ($result.status -eq 'blocked') {
    $entry['attempts'] = $previousAttempts
    $entry['status'] = 'blocked'
    Save-State
    Initialize-Label 'nyx-blocked' 'FBCA04' 'The automated runner cannot do this unattended; answer the question and remove the label'
    Add-GhLabel 'issue' $number 'nyx-blocked'
    Add-GhComment 'issue' $number ('The runner could not implement this issue unattended: ' + $result.reason + "`n`n" + 'Answer the question or make the decision here, then remove the `nyx-blocked` label so it is picked up again.') $runDir
    Add-FinishedTree $worktree $branch $true
    $script:LastUnitDetail = ConvertTo-SingleLine ([string]$result.reason) 200
    return 'blocked'
  }
  if (-not $result.title) {
    Write-Log ('issue #' + $number + ': result.json has no title; attempt ' + $entry['attempts'])
    $entry['status'] = 'failed'
    Save-State
    $script:LastUnitDetail = 'result.json has no title'
    return 'failed'
  }
  $body = Read-Text $bodyPath
  if ([string]::IsNullOrWhiteSpace($body) -or (Get-Item -LiteralPath $bodyPath).LastWriteTimeUtc -lt $agentStart) {
    Write-Log ('issue #' + $number + ': no fresh pr-body.md; attempt ' + $entry['attempts'])
    $entry['status'] = 'failed'
    Save-State
    $script:LastUnitDetail = 'no fresh pr-body.md'
    return 'failed'
  }

  $guard = Get-DiffGuard $worktree
  if ($guard.files.Count -eq 0) {
    Write-Log ('issue #' + $number + ': empty diff; attempt ' + $entry['attempts'])
    $entry['status'] = 'failed'
    Save-State
    $script:LastUnitDetail = 'empty diff'
    return 'failed'
  }
  if ($guard.trips.Count -gt 0) {
    $entry['attempts'] = $previousAttempts
    $script:LastUnitDetail = 'diff guard: ' + ($guard.trips -join '; ')
    Set-NeedsHuman $number 0 ('The runner did not open a pull request because the change ' + ($guard.trips -join '; ') + '. The work is kept locally on branch `' + $branch + '`; nothing was pushed.') $runDir
    return 'needs-human'
  }

  $messagePath = Join-Path $runDir 'commit.txt'
  $null = Save-Commit $worktree ($result.title + "`n`n" + 'Implemented by an AI coding agent (Devin); agent self-tested.' + "`n") $messagePath
  $entry['attempts'] = $previousAttempts
  if ($DryRun) {
    Write-Log ('issue #' + $number + ': DryRun, committed locally on ' + $branch + '; not pushed')
    $entry['status'] = 'dry-run'
    Save-State
    return 'dry-run'
  }

  $push = Invoke-Git $worktree ('push -u origin ' + $branch)
  if ($push.exitCode -ne 0) {
    Write-Log ('issue #' + $number + ': git push failed: ' + (Get-ErrorSummary $push))
    $entry['status'] = 'failed'
    $entry['attempts'] = $previousAttempts + 1
    Save-State
    $script:LastUnitDetail = 'git push failed'
    return 'failed'
  }
  $publishBody = Protect-PublicText $body
  if ($publishBody -notmatch ('(?i)closes\s+#' + $number + '\b')) { $publishBody = $publishBody.TrimEnd() + "`n`nCloses #" + $number + "`n" }
  $publishPath = Join-Path $runDir 'pr-body.publish.md'
  Write-Text $publishPath $publishBody
  $publishTitle = Protect-PublicText $result.title
  $create = Invoke-Gh ('pr create -R ' + $Repo + ' --base main --head ' + $branch + ' --title ' + (Quote-Argument $publishTitle) + ' --body-file ' + (Quote-Argument $publishPath))
  $pr = 0
  if ($create.exitCode -eq 0) {
    $match = [regex]::Match([string]$create.text, '/pull/([0-9]+)')
    if ($match.Success) { $pr = [int]$match.Groups[1].Value }
  }
  if ($pr -le 0) { $pr = Find-OpenPrForBranch $branch }
  if ($pr -le 0) {
    Write-Log ('issue #' + $number + ': gh pr create failed: ' + (Get-ErrorSummary $create))
    $entry['status'] = 'failed'
    $entry['attempts'] = $previousAttempts + 1
    Save-State
    $script:LastUnitDetail = 'gh pr create failed'
    return 'failed'
  }
  $entry['status'] = 'in-pr'
  $entry['pr'] = $pr
  Save-State
  Write-Log ('issue #' + $number + ': opened PR #' + $pr)
  return (Invoke-PrPipeline $number $pr $branch $runDir)
}

function Remove-OldItems {
  param([string]$Directory, [bool]$Directories)
  $failed = @()
  $cutoff = (Get-Date).AddDays(-30)
  if (-not (Test-Path -LiteralPath $Directory -PathType Container)) { return $failed }
  if ($Directories) { $items = @(Get-ChildItem -LiteralPath $Directory -Directory -ErrorAction SilentlyContinue) }
  else { $items = @(Get-ChildItem -LiteralPath $Directory -File -ErrorAction SilentlyContinue) }
  foreach ($old in $items) {
    if ($old.LastWriteTime -ge $cutoff) { continue }
    try { Remove-Item -LiteralPath $old.FullName -Recurse -Force -ErrorAction Stop } catch { $failed += ('cannot delete old item ' + $old.Name) }
  }
  return $failed
}

function Publish-IssueOutcomeTracking {
  param(
    [int]$IssueNumber,
    [string]$Title,
    [int]$PrNumber,
    [string]$Outcome,
    [string]$Detail,
    [int]$Attempts,
    [bool]$WillRetry,
    [string]$TempDir
  )
  if ($DryRun) { return }
  switch ($Outcome) {
    'merged' {
      $null = Add-TrackingComment (Format-TrackingIssueLine $IssueNumber $Title ('merged in #' + $PrNumber)) $TempDir
    }
    'needs-human' {
      $why = $Detail
      if (-not $why) { $why = 'stopped for maintainer decision' }
      $null = Add-TrackingComment (Format-TrackingIssueLine $IssueNumber $Title ('needs-human: ' + $why)) $TempDir
    }
    'closed' {
      $why = $Detail
      if (-not $why) { $why = 'pull request was closed without merging' }
      $null = Add-TrackingComment (Format-TrackingIssueLine $IssueNumber $Title ('needs-human: ' + $why)) $TempDir
    }
    'blocked' {
      $why = $Detail
      if (-not $why) { $why = 'blocked unattended' }
      $null = Add-TrackingComment (Format-TrackingIssueLine $IssueNumber $Title ('blocked: ' + $why)) $TempDir
    }
    'skipped' {
      $why = $Detail
      if (-not $why) { $why = 'skipped' }
      $null = Add-TrackingComment (Format-TrackingIssueLine $IssueNumber $Title ('skipped: ' + $why)) $TempDir
    }
    'deferred' {
      $why = $Detail
      if (-not $why) { $why = 'deferred' }
      $null = Add-TrackingComment (Format-TrackingIssueLine $IssueNumber $Title ('deferred (' + $why + ')')) $TempDir
    }
    'failed' {
      $why = $Detail
      if (-not $why) { $why = 'failed' }
      if ($WillRetry) {
        $null = Add-TrackingComment (Format-TrackingIssueLine $IssueNumber $Title ('attempt ' + $Attempts + ' failed (' + $why + '), will retry')) $TempDir
      } else {
        $null = Add-TrackingComment (Format-TrackingIssueLine $IssueNumber $Title ('failed (' + $why + ')')) $TempDir
      }
    }
  }
}

$mergedOut = @()
$workedOut = @()
$skippedOut = @()
$errorsOut = @()
$lock = $null
$ok = $true
$stopped = $false
$summaryName = 'last-run.json'

try {
  if ([Environment]::OSVersion.Platform -ne [PlatformID]::Win32NT) { throw 'Windows is required.' }
  if ([string]::IsNullOrWhiteSpace($Root)) { throw '-Root is required.' }
  if ([string]::IsNullOrWhiteSpace($Checkout)) { throw '-Checkout is required.' }
  if (-not $DryRun -and [string]::IsNullOrWhiteSpace($ReviewRoot)) { throw '-ReviewRoot is required.' }
  if (-not $DryRun -and [string]::IsNullOrWhiteSpace($StandardCredentialFile)) { throw '-StandardCredentialFile is required.' }
  if ([string]::IsNullOrWhiteSpace($Repo) -or $Repo -notmatch '^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$') { throw '-Repo must be owner/name.' }
  if ($IssueNumber -lt 0) { throw '-IssueNumber must be a positive issue number.' }
  if ($TrackingIssue -lt 0) { throw '-TrackingIssue must be a positive issue number.' }

  $WorkRoot = Get-AcceptancePath $Root
  Assert-OutsideGitCheckout $WorkRoot
  # Keeps state and worktrees out of the directory that contains scripts\: Invoke-AsStandardUser treats it as the repository.
  Assert-AcceptanceOutsideRepo $WorkRoot
  Assert-CmdSafePath '-Root' $WorkRoot
  [IO.Directory]::CreateDirectory($WorkRoot) | Out-Null
  $script:WorkRoot = $WorkRoot
  $script:LogsDir = Join-Path $WorkRoot 'logs'
  [IO.Directory]::CreateDirectory($script:LogsDir) | Out-Null
  $script:LogPath = Join-Path $script:LogsDir ('dev-loop-' + [DateTime]::Now.ToString('yyyyMMdd') + '.log')

  if (Test-Path -LiteralPath (Join-Path $WorkRoot 'STOP')) {
    $stopped = $true
    $skippedOut += [ordered]@{ issue = $null; reason = 'the STOP file exists' }
    Write-Log 'STOP file present; exiting'
  } else {
    # One pass at a time. A second start writes last-skipped.json, so the running pass's last-run.json survives.
    try {
      $lock = [IO.File]::Open((Join-Path $WorkRoot 'lock'), [IO.FileMode]::OpenOrCreate,
        [IO.FileAccess]::ReadWrite, [IO.FileShare]::None)
    } catch {
      $skippedOut += [ordered]@{ issue = $null; reason = 'another run holds the lock' }
      $summaryName = 'last-skipped.json'
    }
  }

  if ($lock) {
    $script:CheckoutPath = Get-AcceptancePath $Checkout
    Assert-CmdSafePath '-Checkout' $script:CheckoutPath
    if (-not (Test-Path -LiteralPath (Join-Path $script:CheckoutPath '.git'))) { throw '-Checkout must be the root of a git clone.' }
    Assert-AcceptanceOutsideRepo $WorkRoot @($script:CheckoutPath)
    foreach ($template in @($script:DevPrompt, $script:FixPrompt)) {
      if (-not (Test-Path -LiteralPath $template -PathType Leaf)) { throw ((Split-Path -Leaf $template) + ' is missing.') }
    }
    $script:ReferencePath = $null
    if ($Reference) {
      $script:ReferencePath = Get-AcceptancePath $Reference
      Assert-CmdSafePath '-Reference' $script:ReferencePath
      if (-not (Test-Path -LiteralPath $script:ReferencePath -PathType Container)) { throw '-Reference must be an existing directory.' }
    }
    $script:ReviewRootPath = $null
    $script:ReviewCheckoutPath = $script:CheckoutPath
    $script:CredentialPath = $null
    $script:ReviewTokenPath = $null
    if (-not $DryRun) {
      $script:ReviewRootPath = Get-AcceptancePath $ReviewRoot
      Assert-CmdSafePath '-ReviewRoot' $script:ReviewRootPath
      if ($script:ReviewRootPath.Equals($WorkRoot, [StringComparison]::OrdinalIgnoreCase)) { throw '-ReviewRoot must differ from -Root.' }
      if ($ReviewCheckout) { $script:ReviewCheckoutPath = Get-AcceptancePath $ReviewCheckout }
      Assert-CmdSafePath '-ReviewCheckout' $script:ReviewCheckoutPath
      if (-not (Test-Path -LiteralPath (Join-Path $script:ReviewCheckoutPath '.git'))) { throw '-ReviewCheckout must be the root of a git clone.' }
      $script:CredentialPath = Get-AcceptancePath $StandardCredentialFile
      Assert-CmdSafePath '-StandardCredentialFile' $script:CredentialPath
      if (-not (Test-Path -LiteralPath $script:CredentialPath -PathType Leaf)) { throw '-StandardCredentialFile does not exist.' }
      if ($ReviewTokenFile) {
        $script:ReviewTokenPath = Get-AcceptancePath $ReviewTokenFile
        Assert-CmdSafePath '-ReviewTokenFile' $script:ReviewTokenPath
        if (-not (Test-Path -LiteralPath $script:ReviewTokenPath -PathType Leaf)) { throw '-ReviewTokenFile does not exist.' }
      }
      if (-not (Test-Path -LiteralPath $script:ReviewScript -PathType Leaf)) { throw 'Invoke-PrReview.ps1 is missing; keep scripts\dev-loop next to scripts\pr-review.' }
      $script:ReviewScript = Get-AcceptancePath $script:ReviewScript
    }

    # A hidden task must never wait for an interactive prompt from gh or git.
    $env:GH_PROMPT_DISABLED = '1'
    $env:GH_NO_UPDATE_NOTIFIER = '1'
    $env:GIT_TERMINAL_PROMPT = '0'
    $env:GCM_INTERACTIVE = 'never'

    $git = Get-Command -Name 'git' -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
    if (-not $git) { throw 'git was not found on PATH.' }
    $script:GitPath = $git.Source
    $gh = Get-Command -Name 'gh' -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
    if (-not $gh) { throw 'GitHub CLI (gh) was not found on PATH.' }
    $script:GhPath = $gh.Source
    $devin = Get-Command -Name 'devin' -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
    if (-not $devin) { throw 'Devin CLI was not found on PATH; install it and sign in as the operating account.' }
    $script:DevinPath = $devin.Source

    $redact = @($WorkRoot, $script:CheckoutPath, $script:ReviewRootPath, $script:ReviewCheckoutPath, $script:ReferencePath,
      $script:CredentialPath, $script:ReviewTokenPath, $env:USERPROFILE, (Split-Path -Parent (Split-Path -Parent $PSScriptRoot)))
    $redactAll = @()
    foreach ($item in $redact) {
      if ([string]::IsNullOrWhiteSpace($item) -or $item.Length -lt 4) { continue }
      $redactAll += $item
      $redactAll += $item.Replace('\', '/')
    }
    if ($env:COMPUTERNAME -and $env:COMPUTERNAME.Length -ge 6) { $redactAll += $env:COMPUTERNAME }
    $script:Redactions = @($redactAll | Sort-Object -Unique | Sort-Object { $_.Length } -Descending)

    $script:RunsDir = Join-Path $WorkRoot 'runs'
    [IO.Directory]::CreateDirectory($script:RunsDir) | Out-Null
    $script:StatePath = Join-Path $WorkRoot 'state.json'
    $script:State = Read-State $script:StatePath
    Save-State

    $script:Me = Get-GhLogin
    Write-Log ('run start; signed in to gh as the operating account; dry run: ' + [bool]$DryRun)
    # Commits need an identity; fall back to the account's GitHub noreply address only when git has none.
    $configured = Invoke-Git $script:CheckoutPath 'config user.email'
    if ($configured.exitCode -ne 0 -or [string]::IsNullOrWhiteSpace($configured.text)) {
      $idResult = Invoke-Gh 'api user --jq .id'
      $accountId = ''
      if ($idResult.exitCode -eq 0 -and $idResult.text) { $accountId = $idResult.text.Trim() + '+' }
      $script:GitIdentity = '-c user.name=' + (Quote-Argument $script:Me) + ' -c user.email=' + (Quote-Argument ($accountId + $script:Me + '@users.noreply.github.com')) + ' '
    }

    if (-not $DryRun -and (Get-MergesToday) -ge $MaxMergesPerDay) {
      $skippedOut += [ordered]@{ issue = $null; reason = ('the daily merge limit of ' + $MaxMergesPerDay + ' is reached') }
      Write-Log 'daily merge limit reached; nothing to do'
      Send-MergeCapNoticeIfNeeded
    } else {
      $null = Invoke-Git $script:CheckoutPath 'worktree prune'
      # The review clone's pr-<n> refs live under refs/remotes/origin, so pruning there would delete them.
      $prune = ''
      if (-not $script:ReviewCheckoutPath.Equals($script:CheckoutPath, [StringComparison]::OrdinalIgnoreCase)) { $prune = ' --prune' }
      $fetch = Invoke-Git $script:CheckoutPath ('fetch origin' + $prune)
      if ($fetch.exitCode -ne 0) { throw ('git fetch failed: ' + (Get-ErrorSummary $fetch)) }

      $openPrs = @(Get-OpenPrs)
      $nyxPrIssues = @{}
      $resume = @()
      foreach ($pull in $openPrs) {
        $branchName = [string]$pull.headRefName
        $match = [regex]::Match($branchName, '^nyx/([0-9]+)-')
        if (-not $match.Success) { continue }
        $nyxPrIssues[[int]$match.Groups[1].Value] = $true
        if ([string]$pull.author.login -ne $script:Me) { continue }
        if ($pull.isCrossRepository -or [string]$pull.baseRefName -ne 'main') { continue }
        if (-not (Test-BranchName $branchName)) { continue }
        if ((Get-LabelNames $pull.labels) -contains 'needs-human') { continue }
        $issueOfPr = [int]$match.Groups[1].Value
        if ($IssueNumber -gt 0 -and $issueOfPr -ne $IssueNumber) { continue }
        $resume += [pscustomobject]@{
          number = [int]$pull.number; issue = $issueOfPr; branch = $branchName
          title = (ConvertTo-SingleLine ([string]$pull.title) 200)
        }
      }
      $resume = @($resume | Sort-Object { [int]$_.number })

      if ($resume.Count -gt 0 -and -not $DryRun -and $IssueNumber -eq 0 -and [bool]$script:State['queueEmptyNotified']) {
        $script:State['queueEmptyNotified'] = $false
        Save-State
      }

      $units = 0
      $hold = $false
      $hitMergeCap = $false
      if ($DryRun -and $resume.Count -gt 0) {
        Write-Log 'DryRun: open nyx/ pull requests are not resumed'
      } elseif (-not $DryRun) {
        foreach ($candidate in $resume) {
          if ($units -ge $MaxIssuesPerRun) { $hold = $true; break }
          if (Test-Stop) { $stopped = $true; $hold = $true; break }
          if ((Get-MergesToday) -ge $MaxMergesPerDay) { $hitMergeCap = $true; $hold = $true; break }
          $units++
          $stamp = [DateTime]::Now.ToString('yyyyMMddTHHmmss')
          $runDir = Join-Path $script:RunsDir ('issue-' + $candidate.issue + '-' + $stamp)
          [IO.Directory]::CreateDirectory($runDir) | Out-Null
          try {
            Write-Log ('resuming PR #' + $candidate.number + ' for issue #' + $candidate.issue)
            $outcome = Invoke-PrPipeline $candidate.issue $candidate.number $candidate.branch $runDir
            $workedOut += [ordered]@{ issue = $candidate.issue; pr = $candidate.number; outcome = $outcome; runDir = $runDir }
            if ($outcome -eq 'merged') { $mergedOut += [ordered]@{ issue = $candidate.issue; pr = $candidate.number } }
            if ($outcome -eq 'stopped') {
              $stopped = $true
              $hold = $true
              break
            }
            $issueTitle = $candidate.title
            $issueView = Get-IssueView $candidate.issue
            if ($issueView -and $issueView.title) { $issueTitle = ConvertTo-SingleLine ([string]$issueView.title) 200 }
            Publish-IssueOutcomeTracking $candidate.issue $issueTitle $candidate.number $outcome $script:LastUnitDetail 0 $false $runDir
          } catch {
            $errorsOut += [ordered]@{ issue = $candidate.issue; pr = $candidate.number; error = $_.Exception.Message; runDir = $runDir }
            Write-Log ('error on PR #' + $candidate.number + ': ' + $_.Exception.Message)
            Publish-IssueOutcomeTracking $candidate.issue $candidate.title $candidate.number 'failed' ('error: ' + (ConvertTo-SingleLine $_.Exception.Message 160)) 0 $false $runDir
          }
        }
      }

      if (-not $DryRun -and -not $hold -and -not $stopped -and (Get-MergesToday) -ge $MaxMergesPerDay) {
        $hitMergeCap = $true
        $hold = $true
      }

      if (-not $hold -and -not $stopped -and $units -lt $MaxIssuesPerRun) {
        $candidates = @()
        if ($IssueNumber -gt 0) {
          $forced = Get-IssueView $IssueNumber
          if (-not $forced) { throw ('cannot read issue #' + $IssueNumber) }
          $forcedTitle = ConvertTo-SingleLine ([string]$forced.title) 200
          if ($nyxPrIssues.ContainsKey($IssueNumber)) {
            $skippedOut += [ordered]@{ issue = $IssueNumber; reason = 'an open pull request from a nyx/ branch already exists' }
            Publish-IssueOutcomeTracking $IssueNumber $forcedTitle 0 'skipped' 'an open pull request from a nyx/ branch already exists' 0 $false $script:LogsDir
          } else {
            $candidates = @([pscustomobject]@{ number = $IssueNumber; title = $forcedTitle })
          }
        } else {
          $listResult = Invoke-Gh ('issue list -R ' + $Repo + ' --state open --label ' + $Label + ' --limit 200 --json number,title,labels')
          if ($listResult.exitCode -ne 0) { throw ('gh issue list failed: ' + (Get-ErrorSummary $listResult)) }
          $issues = @()
          if (-not [string]::IsNullOrWhiteSpace($listResult.text)) { $issues = @($listResult.text | ConvertFrom-Json | ForEach-Object { $_ }) }
          foreach ($issue in @($issues | Sort-Object { [int]$_.number })) {
            $labelNames = @(Get-LabelNames $issue.labels)
            $issueNo = [int]$issue.number
            $issueTitle = ConvertTo-SingleLine ([string]$issue.title) 200
            if ($labelNames -contains 'needs-human' -or $labelNames -contains 'nyx-blocked') { continue }
            if ($nyxPrIssues.ContainsKey($issueNo)) { continue }
            $known = Get-IssueEntry $issueNo
            if ($known['status'] -eq 'merged') {
              $skippedOut += [ordered]@{ issue = $issueNo; reason = 'merged earlier but the issue is still open' }
              if (-not $DryRun -and -not [bool]$known['skipNotified']) {
                if (Add-TrackingComment (Format-TrackingIssueLine $issueNo $issueTitle 'skipped: merged earlier but the issue is still open') $script:LogsDir) {
                  $known['skipNotified'] = $true
                  Save-State
                }
              }
              continue
            }
            if ($known['status'] -eq 'in-pr' -and $known['pr']) {
              # Its PR is no longer open and the runner did not see how it ended.
              $gone = Get-PrInfo ([int]$known['pr'])
              if ($gone -and $gone.state -eq 'MERGED') {
                $known['status'] = 'merged'
                if (-not $DryRun -and -not [bool]$known['skipNotified']) {
                  if (Add-TrackingComment (Format-TrackingIssueLine $issueNo $issueTitle ('skipped: PR #' + $known['pr'] + ' was merged')) $script:LogsDir) {
                    $known['skipNotified'] = $true
                  }
                }
                Save-State
                $skippedOut += [ordered]@{ issue = $issueNo; reason = 'its pull request was merged' }
                continue
              }
              Set-NeedsHuman $issueNo 0 ('PR #' + $known['pr'] + ' is no longer open and was not merged, so the runner will not take this issue again until someone decides.') $script:LogsDir
              Publish-IssueOutcomeTracking $issueNo $issueTitle 0 'needs-human' ('PR #' + $known['pr'] + ' was closed without merging') 0 $false $script:LogsDir
              $skippedOut += [ordered]@{ issue = $issueNo; reason = 'its pull request was closed without merging' }
              continue
            }
            if ([int]$known['attempts'] -ge 2) {
              Set-NeedsHuman $issueNo 0 ('The runner tried this issue ' + $known['attempts'] + ' times without producing a pull request, so it stops here for a person.') $script:LogsDir
              Publish-IssueOutcomeTracking $issueNo $issueTitle 0 'needs-human' ('tried ' + $known['attempts'] + ' times without producing a pull request') ([int]$known['attempts']) $false $script:LogsDir
              $skippedOut += [ordered]@{ issue = $issueNo; reason = 'attempted ' + $known['attempts'] + ' times' }
              continue
            }
            $candidates += [pscustomobject]@{ number = $issueNo; title = $issueTitle }
          }
        }

        if ($candidates.Count -gt 0 -and -not $DryRun -and $IssueNumber -eq 0 -and [bool]$script:State['queueEmptyNotified']) {
          $script:State['queueEmptyNotified'] = $false
          Save-State
        }

        $issueQueue = New-Object Collections.Generic.Queue[object]
        foreach ($candidate in $candidates) { $issueQueue.Enqueue($candidate) }
        $triedInPass = @{}

        while ($issueQueue.Count -gt 0) {
          if ($units -ge $MaxIssuesPerRun) { break }
          if (Test-Stop) { $stopped = $true; break }
          if (-not $DryRun -and (Get-MergesToday) -ge $MaxMergesPerDay) { $hitMergeCap = $true; break }
          $candidate = $issueQueue.Dequeue()
          $issueNo = [int]$candidate.number
          $priorTries = 0
          if ($triedInPass.ContainsKey($issueNo)) { $priorTries = [int]$triedInPass[$issueNo] }
          if ($priorTries -ge 2) { continue }

          $entry = Get-IssueEntry $issueNo
          if ($IssueNumber -eq 0 -and [int]$entry['attempts'] -ge 2) {
            Set-NeedsHuman $issueNo 0 ('The runner tried this issue ' + $entry['attempts'] + ' times without producing a pull request, so it stops here for a person.') $script:LogsDir
            Publish-IssueOutcomeTracking $issueNo ([string]$candidate.title) 0 'needs-human' ('tried ' + $entry['attempts'] + ' times without producing a pull request') ([int]$entry['attempts']) $false $script:LogsDir
            continue
          }

          $units++
          $triedInPass[$issueNo] = $priorTries + 1
          try {
            $outcome = Invoke-IssueUnit $candidate
            $entry = Get-IssueEntry $issueNo
            $prNumber = $null
            $prInt = 0
            if ($entry['pr']) { $prNumber = [int]$entry['pr']; $prInt = $prNumber }
            $workedOut += [ordered]@{ issue = $issueNo; pr = $prNumber; outcome = $outcome; runDir = $entry['lastRunDir'] }
            if ($outcome -eq 'merged') { $mergedOut += [ordered]@{ issue = $issueNo; pr = $prNumber } }
            if ($outcome -eq 'stopped') {
              $stopped = $true
              break
            }
            $issueTitle = $script:LastUnitTitle
            if (-not $issueTitle) { $issueTitle = [string]$candidate.title }
            $commentDir = [string]$entry['lastRunDir']
            if (-not $commentDir) { $commentDir = $script:LogsDir }

            if ($outcome -eq 'failed') {
              $attemptsNow = [int]$entry['attempts']
              $failDetail = $script:LastUnitDetail
              if (-not $failDetail) { $failDetail = 'failed' }
              if ($attemptsNow -lt 2 -and [int]$triedInPass[$issueNo] -lt 2) {
                Publish-IssueOutcomeTracking $issueNo $issueTitle 0 'failed' $failDetail $attemptsNow $true $commentDir
                $issueQueue.Enqueue($candidate)
              } else {
                $nhReason = 'The runner tried this issue ' + $attemptsNow + ' times without producing a pull request, so it stops here for a person.'
                Set-NeedsHuman $issueNo 0 $nhReason $commentDir
                Publish-IssueOutcomeTracking $issueNo $issueTitle 0 'needs-human' ('tried ' + $attemptsNow + ' times without producing a pull request; last: ' + $failDetail) $attemptsNow $false $commentDir
              }
            } else {
              Publish-IssueOutcomeTracking $issueNo $issueTitle $prInt $outcome $script:LastUnitDetail ([int]$entry['attempts']) $false $commentDir
            }
          } catch {
            $errorsOut += [ordered]@{ issue = $issueNo; error = $_.Exception.Message }
            Write-Log ('error on issue #' + $issueNo + ': ' + $_.Exception.Message)
            Publish-IssueOutcomeTracking $issueNo ([string]$candidate.title) 0 'failed' ('error: ' + (ConvertTo-SingleLine $_.Exception.Message 160)) 0 $false $script:LogsDir
          }
        }

        if ($candidates.Count -eq 0 -and $skippedOut.Count -eq 0) { Write-Log 'no eligible issue' }
        if ($IssueNumber -eq 0 -and $resume.Count -eq 0 -and $candidates.Count -eq 0 -and -not $DryRun -and -not $stopped -and -not $hitMergeCap) {
          if (-not [bool]$script:State['queueEmptyNotified']) {
            if (Add-TrackingComment ('No open ' + $Label + ' issues left; idle until new ones are labelled.') $script:LogsDir) {
              $script:State['queueEmptyNotified'] = $true
              Save-State
            }
          }
        }
      }

      if ($hitMergeCap) { Send-MergeCapNoticeIfNeeded }
    }
  }
} catch {
  $ok = $false
  $errorsOut += [ordered]@{ issue = $null; error = $_.Exception.Message }
  Write-Log ('run error: ' + $_.Exception.Message)
} finally {
  if ($script:GitPath -and $script:CheckoutPath) {
    foreach ($tree in $script:FinishedTrees) {
      try { Remove-Worktree $tree.path $tree.branch $tree.deleteBranch } catch { Write-Log ('worktree cleanup failed: ' + $_.Exception.Message) }
    }
  }
  if ($lock -and $WorkRoot) {
    foreach ($retentionError in @(Remove-OldItems (Join-Path $WorkRoot 'runs') $true) + @(Remove-OldItems (Join-Path $WorkRoot 'logs') $false)) {
      $errorsOut += [ordered]@{ issue = $null; error = $retentionError }
    }
  }
  if ($lock) { $lock.Dispose() }
}

$summary = [ordered]@{
  ok = ($ok -and $errorsOut.Count -eq 0)
  stopped = $stopped
  dryRun = [bool]$DryRun
  merged = $mergedOut
  worked = $workedOut
  skipped = $skippedOut
  errors = $errorsOut
}
$json = ConvertTo-Json -InputObject $summary -Depth 6 -Compress
if ($WorkRoot -and (Test-Path -LiteralPath $WorkRoot)) {
  try { Write-Text (Join-Path $WorkRoot $summaryName) ($json + "`n") } catch { }
} elseif ($Root) {
  try {
    $fallback = Get-AcceptancePath $Root
    [IO.Directory]::CreateDirectory($fallback) | Out-Null
    Write-Text (Join-Path $fallback 'last-run.json') ($json + "`n")
  } catch { }
}
[Console]::Out.WriteLine($json)
# Per-issue failures are recorded in errors; only a run-level failure is a nonzero exit.
if ($ok) { exit 0 }
exit 1
