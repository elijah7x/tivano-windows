# Tivano Windows - derived from Tivano (AGPL-3.0), modified 2026-11-14.
# Droppy Code by Jordy Spruit (Droppy), https://getdroppycode.app
# Usage: .\Invoke-DevLoop.ps1 -Root <state root outside any git checkout> -Checkout <clone used for worktrees> -ReviewRoot <pr-review state root> -StandardCredentialFile <file> [-ReviewCheckout <clone>] [-ReviewTokenFile <file>] [-Reference <macOS baseline clone>] [-IssueNumber <n>] [-DryRun]
# One development pass: resume an open nyx/ PR or take an issue, develop, review, fix, merge. Writes a one-line JSON summary to stdout and <Root>\last-run.json.

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
  [ValidateRange(1, 20)][int]$MaxIssuesPerRun = 1,
  [ValidateRange(1, 50)][int]$MaxMergesPerDay = 4,
  [ValidateRange(0, 5)][int]$MaxFixRounds = 2,
  [ValidateRange(5, 480)][int]$DevinTimeoutMin = 90,
  [int]$IssueNumber = 0,
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
  }
}

function Read-State {
  param([string]$Path)
  $state = @{ issues = @{}; merges = @{} }
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
  $inner = (Quote-Argument $script:DevinPath) + ' --model ' + $DevinModel +
    ' --permission-mode dangerous --respect-workspace-trust false --prompt-file ' + (Quote-Argument $PromptPath) +
    ' -p > ' + (Quote-Argument $LogPath) + ' 2>&1'
  $previous = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  $process = $null
  try {
    $process = Start-Process -FilePath $script:CmdExe -ArgumentList ('/d /c "' + $inner + '"') `
      -WorkingDirectory $Worktree -PassThru -WindowStyle Hidden
  } finally {
    $ErrorActionPreference = $previous
  }
  if (-not $process) { throw 'Could not start the Devin CLI.' }
  # The cap also covers the agent's own retries; taskkill ends the whole tree.
  if (-not $process.WaitForExit($DevinTimeoutMin * 60000)) {
    $null = Invoke-Tool (Join-Path ([Environment]::GetFolderPath('System')) 'taskkill.exe') ('/T /F /PID ' + $process.Id) `
      (Join-Path $RunDir ('devin-kill-' + $KillTag + '.out.log')) (Join-Path $RunDir ('devin-kill-' + $KillTag + '.err.log'))
    return 'timeout'
  }
  return ('exitCode ' + $process.ExitCode)
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
    Set-NeedsHuman $Issue $Pr ('The automated review could not be completed twice in a row (' + $Why + '). Leaving the PR open for a person.') $RunDir
    return 'needs-human'
  }
  return 'deferred'
}

# Judge, fix, repeat. Returns one of merged, closed, needs-human, deferred, stopped.
function Invoke-PrPipeline {
  param([int]$Issue, [int]$Pr, [string]$Branch, [string]$RunDir)
  $entry = Get-IssueEntry $Issue
  $entry['pr'] = $Pr
  $entry['branch'] = $Branch
  $entry['lastRunDir'] = $RunDir
  $worktree = Join-Path $script:WorkRoot ('work\issue-' + $Issue)
  Save-State
  $freshReview = $false

  while ($true) {
    if (Test-Stop) { return 'stopped' }
    $info = Get-PrInfo $Pr
    if (-not $info) { throw ('cannot read PR #' + $Pr) }
    if ($info.state -eq 'MERGED') {
      $entry['status'] = 'merged'
      Save-State
      Add-FinishedTree $worktree $Branch $true
      return 'merged'
    }
    if ($info.state -ne 'OPEN') {
      # A person closed it. Do not redo the work behind their back.
      Set-NeedsHuman $Issue 0 ('PR #' + $Pr + ' was closed without merging, so the runner will not take this issue again until someone decides.') $RunDir
      $entry['status'] = 'needs-human'
      Save-State
      Add-FinishedTree $worktree $Branch $false
      return 'closed'
    }
    if ($info.branch -ne $Branch -or $info.author -ne $script:Me -or $info.cross -or $info.base -ne 'main' -or -not $info.branch.StartsWith('nyx/')) {
      throw ('PR #' + $Pr + ' is not one of this runner''s nyx/ pull requests')
    }
    if ($info.labels -contains 'needs-human') { return 'needs-human' }
    if ($info.draft) { Write-Log ('PR #' + $Pr + ' is a draft; left alone'); return 'deferred' }
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
      if ($review.status -eq 'busy') { Write-Log 'the reviewer is busy; will retry next run'; return 'deferred' }
      if ($review.status -ne 'ok') { return (Register-ReviewFailure $Issue $Pr $review.message $RunDir) }
      $evaluation = Test-GateResult $review.gate $true
      if ($evaluation.infra.Count -eq 0 -and $evaluation.content.Count -gt 0 -and $evaluation.flakeCandidate) {
        # Only unit failures are in the way: run the review once more, without a second comment, to rule out a flake.
        Write-Log 'only new unit failures; re-running the review once to rule out a flake'
        $flakeNames = @($evaluation.newFailures)
        $second = Invoke-Review $Pr $sha $RunDir $true ('r' + [int]$entry['fixRounds'] + 'b')
        if ($second.status -eq 'busy') { return 'deferred' }
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
        return 'merged'
      }
      if ($merge.result -eq 'cap') { Write-Log $merge.message; return 'deferred' }
      if ($merge.result -eq 'changed') { continue }
      $failures = [int]$entry['mergeFailures'] + 1
      $entry['mergeFailures'] = $failures
      Save-State
      Write-Log ('merge failed (' + $failures + '): ' + $merge.message)
      if ($failures -ge 3) {
        Set-NeedsHuman $Issue $Pr ('The merge failed three times: ' + $merge.message) $RunDir
        return 'needs-human'
      }
      return 'deferred'
    }

    # The gate failed on content: use a fix round, or hand over.
    $round = [int]$entry['fixRounds'] + 1
    $failuresPath = Join-Path $RunDir ('gate-failures-' + $round + '.md')
    Write-GateFailures $failuresPath $evaluation $extra $sha
    if ([int]$entry['fixRounds'] -ge $MaxFixRounds) {
      $summary = @($extra) + @($evaluation.content)
      $listed = (@($summary | Select-Object -First 8) | ForEach-Object { '- ' + $_ }) -join "`n"
      Set-NeedsHuman $Issue $Pr ('The merge gate still fails for head ' + $sha.Substring(0, 7) + ' after ' + $MaxFixRounds + ' fix round(s):' + "`n`n" + $listed) $RunDir
      return 'needs-human'
    }
    if (Test-Stop) { return 'stopped' }
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
    if ($fix.result -eq 'needs-human') {
      Set-NeedsHuman $Issue $Pr $fix.message $RunDir
      return 'needs-human'
    }
    Write-Log ('fix round ' + $round + ' failed: ' + $fix.message)
    return 'deferred'
  }
}

# ---- one issue, from issue text to a merged PR ----

function Invoke-IssueUnit {
  param($Issue)
  $number = [int]$Issue.number
  $entry = Get-IssueEntry $number
  $stamp = [DateTime]::Now.ToString('yyyyMMddTHHmmss')
  $runDir = Join-Path $script:RunsDir ('issue-' + $number + '-' + $stamp)
  [IO.Directory]::CreateDirectory($runDir) | Out-Null
  $entry['lastRunDir'] = $runDir
  Write-Log ('issue #' + $number + ': start, run ' + (Split-Path -Leaf $runDir))

  $view = Get-IssueView $number
  if (-not $view) { throw ('cannot read issue #' + $number) }
  if ([string]$view.state -ne 'OPEN') { Write-Log ('issue #' + $number + ' is not open'); return 'skipped' }
  $title = ConvertTo-SingleLine ([string]$view.title) 200
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
  if ($devin -ne 'exitCode 0') {
    Write-Log ('issue #' + $number + ': Devin CLI ' + $devin + '; worktree kept, attempt ' + $entry['attempts'])
    $entry['status'] = 'failed'
    Save-State
    return 'failed'
  }
  $result = Read-DevResult $resultPath $agentStart
  if (-not $result) {
    Write-Log ('issue #' + $number + ': no usable result.json; worktree kept, attempt ' + $entry['attempts'])
    $entry['status'] = 'failed'
    Save-State
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
    return 'blocked'
  }
  if (-not $result.title) {
    Write-Log ('issue #' + $number + ': result.json has no title; attempt ' + $entry['attempts'])
    $entry['status'] = 'failed'
    Save-State
    return 'failed'
  }
  $body = Read-Text $bodyPath
  if ([string]::IsNullOrWhiteSpace($body) -or (Get-Item -LiteralPath $bodyPath).LastWriteTimeUtc -lt $agentStart) {
    Write-Log ('issue #' + $number + ': no fresh pr-body.md; attempt ' + $entry['attempts'])
    $entry['status'] = 'failed'
    Save-State
    return 'failed'
  }

  $guard = Get-DiffGuard $worktree
  if ($guard.files.Count -eq 0) {
    Write-Log ('issue #' + $number + ': empty diff; attempt ' + $entry['attempts'])
    $entry['status'] = 'failed'
    Save-State
    return 'failed'
  }
  if ($guard.trips.Count -gt 0) {
    $entry['attempts'] = $previousAttempts
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
    Save-State
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

$mergedOut = @()
$workedOut = @()
$skippedOut = @()
$errorsOut = @()
$lock = $null
$ok = $true
$stopped = $false

try {
  if ([Environment]::OSVersion.Platform -ne [PlatformID]::Win32NT) { throw 'Windows is required.' }
  if ([string]::IsNullOrWhiteSpace($Root)) { throw '-Root is required.' }
  if ([string]::IsNullOrWhiteSpace($Checkout)) { throw '-Checkout is required.' }
  if (-not $DryRun -and [string]::IsNullOrWhiteSpace($ReviewRoot)) { throw '-ReviewRoot is required.' }
  if (-not $DryRun -and [string]::IsNullOrWhiteSpace($StandardCredentialFile)) { throw '-StandardCredentialFile is required.' }
  if ([string]::IsNullOrWhiteSpace($Repo) -or $Repo -notmatch '^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$') { throw '-Repo must be owner/name.' }
  if ($IssueNumber -lt 0) { throw '-IssueNumber must be a positive issue number.' }

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
    # One pass at a time. A second start writes a skipped summary and leaves the first run alone.
    try {
      $lock = [IO.File]::Open((Join-Path $WorkRoot 'lock'), [IO.FileMode]::OpenOrCreate,
        [IO.FileAccess]::ReadWrite, [IO.FileShare]::None)
    } catch {
      $skippedOut += [ordered]@{ issue = $null; reason = 'another run holds the lock' }
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
        $resume += [pscustomobject]@{ number = [int]$pull.number; issue = $issueOfPr; branch = $branchName }
      }
      $resume = @($resume | Sort-Object { [int]$_.number })

      $units = 0
      $hold = $false
      if ($DryRun -and $resume.Count -gt 0) {
        Write-Log 'DryRun: open nyx/ pull requests are not resumed'
      } elseif (-not $DryRun) {
        foreach ($candidate in $resume) {
          if ($units -ge $MaxIssuesPerRun) { $hold = $true; break }
          if (Test-Stop) { $stopped = $true; $hold = $true; break }
          if ((Get-MergesToday) -ge $MaxMergesPerDay) { $hold = $true; break }
          $units++
          $stamp = [DateTime]::Now.ToString('yyyyMMddTHHmmss')
          $runDir = Join-Path $script:RunsDir ('issue-' + $candidate.issue + '-' + $stamp)
          [IO.Directory]::CreateDirectory($runDir) | Out-Null
          try {
            Write-Log ('resuming PR #' + $candidate.number + ' for issue #' + $candidate.issue)
            $outcome = Invoke-PrPipeline $candidate.issue $candidate.number $candidate.branch $runDir
            $workedOut += [ordered]@{ issue = $candidate.issue; pr = $candidate.number; outcome = $outcome; runDir = $runDir }
            if ($outcome -eq 'merged') { $mergedOut += [ordered]@{ issue = $candidate.issue; pr = $candidate.number } }
            if ($outcome -eq 'deferred' -or $outcome -eq 'stopped') { $hold = $true }
            if ($outcome -eq 'stopped') { $stopped = $true }
          } catch {
            $errorsOut += [ordered]@{ issue = $candidate.issue; pr = $candidate.number; error = $_.Exception.Message; runDir = $runDir }
            Write-Log ('error on PR #' + $candidate.number + ': ' + $_.Exception.Message)
            $hold = $true
          }
        }
      }

      if (-not $hold -and -not $stopped -and $units -lt $MaxIssuesPerRun) {
        $candidates = @()
        if ($IssueNumber -gt 0) {
          $forced = Get-IssueView $IssueNumber
          if (-not $forced) { throw ('cannot read issue #' + $IssueNumber) }
          if ($nyxPrIssues.ContainsKey($IssueNumber)) {
            $skippedOut += [ordered]@{ issue = $IssueNumber; reason = 'an open pull request from a nyx/ branch already exists' }
          } else {
            $candidates = @([pscustomobject]@{ number = $IssueNumber })
          }
        } else {
          $listResult = Invoke-Gh ('issue list -R ' + $Repo + ' --state open --label ' + $Label + ' --limit 200 --json number,title,labels')
          if ($listResult.exitCode -ne 0) { throw ('gh issue list failed: ' + (Get-ErrorSummary $listResult)) }
          $issues = @()
          if (-not [string]::IsNullOrWhiteSpace($listResult.text)) { $issues = @($listResult.text | ConvertFrom-Json | ForEach-Object { $_ }) }
          foreach ($issue in @($issues | Sort-Object { [int]$_.number })) {
            $labelNames = @(Get-LabelNames $issue.labels)
            $issueNo = [int]$issue.number
            if ($labelNames -contains 'needs-human' -or $labelNames -contains 'nyx-blocked') { continue }
            if ($nyxPrIssues.ContainsKey($issueNo)) { continue }
            $known = Get-IssueEntry $issueNo
            if ($known['status'] -eq 'merged') {
              $skippedOut += [ordered]@{ issue = $issueNo; reason = 'merged earlier but the issue is still open' }
              continue
            }
            if ($known['status'] -eq 'in-pr' -and $known['pr']) {
              # Its PR is no longer open and the runner did not see how it ended.
              $gone = Get-PrInfo ([int]$known['pr'])
              if ($gone -and $gone.state -eq 'MERGED') {
                $known['status'] = 'merged'
                Save-State
                $skippedOut += [ordered]@{ issue = $issueNo; reason = 'its pull request was merged' }
                continue
              }
              Set-NeedsHuman $issueNo 0 ('PR #' + $known['pr'] + ' is no longer open and was not merged, so the runner will not take this issue again until someone decides.') $script:LogsDir
              $skippedOut += [ordered]@{ issue = $issueNo; reason = 'its pull request was closed without merging' }
              continue
            }
            if ([int]$known['attempts'] -ge 2) {
              Set-NeedsHuman $issueNo 0 ('The runner tried this issue ' + $known['attempts'] + ' times without producing a pull request, so it stops here for a person.') $script:LogsDir
              $skippedOut += [ordered]@{ issue = $issueNo; reason = 'attempted ' + $known['attempts'] + ' times' }
              continue
            }
            $candidates += [pscustomobject]@{ number = $issueNo }
          }
        }
        foreach ($candidate in $candidates) {
          if ($units -ge $MaxIssuesPerRun) { break }
          if (Test-Stop) { $stopped = $true; break }
          if (-not $DryRun -and (Get-MergesToday) -ge $MaxMergesPerDay) { break }
          $units++
          try {
            $outcome = Invoke-IssueUnit $candidate
            $entry = Get-IssueEntry ([int]$candidate.number)
            $prNumber = $null
            if ($entry['pr']) { $prNumber = [int]$entry['pr'] }
            $workedOut += [ordered]@{ issue = [int]$candidate.number; pr = $prNumber; outcome = $outcome; runDir = $entry['lastRunDir'] }
            if ($outcome -eq 'merged') { $mergedOut += [ordered]@{ issue = [int]$candidate.number; pr = $prNumber } }
            if ($outcome -eq 'stopped') { $stopped = $true }
          } catch {
            $errorsOut += [ordered]@{ issue = [int]$candidate.number; error = $_.Exception.Message }
            Write-Log ('error on issue #' + $candidate.number + ': ' + $_.Exception.Message)
          }
        }
        if ($candidates.Count -eq 0 -and $skippedOut.Count -eq 0) { Write-Log 'no eligible issue' }
      }
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
  try { Write-Text (Join-Path $WorkRoot 'last-run.json') ($json + "`n") } catch { }
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
