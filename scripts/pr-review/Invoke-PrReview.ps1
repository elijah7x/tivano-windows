# Tivano Windows - derived from Tivano (AGPL-3.0), modified 2026-11-10.
# Droppy Code by Jordy Spruit (Droppy), https://getdroppycode.app
# Usage: .\Invoke-PrReview.ps1 -Root <state root outside any git checkout> -Checkout <clone used only for worktrees> -StandardCredentialFile <file> [-TokenFile <file>] [-Reference <macOS baseline clone>] [-DryRun] [-PrNumber <n>]
# One polling pass. Writes a one-line JSON summary to stdout and <Root>\last-run.json.

param(
  [string]$Repo = 'elijah7x/tivano-windows',
  [string]$Root,
  [string]$Checkout,
  [string]$StandardCredentialFile,
  [string]$TokenFile,
  [string]$Reference,
  [string]$DevinModel = 'swe-2-high',
  [ValidateRange(1, 20)][int]$MaxPerRun = 1,
  [switch]$DryRun,
  [int]$PrNumber = 0
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
  $out = Join-Path $script:WorkRoot '.git.out.tmp'
  $err = Join-Path $script:WorkRoot '.git.err.tmp'
  $code = Invoke-Tool $script:GitPath ('-C ' + (Quote-Argument $Checkout) + ' ' + $Arguments) $out $err
  return [pscustomobject]@{ exitCode = $code; text = (Read-Text $out); error = (Read-Text $err) }
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

function Save-State {
  param([string]$Path, $State)
  $temporary = $Path + '.tmp'
  Write-Text $temporary ((ConvertTo-Json -InputObject $State -Depth 8) + "`n")
  if (Test-Path -LiteralPath $Path) {
    # PowerShell turns $null into an empty string for a string parameter; File.Replace needs a real null.
    [IO.File]::Replace($temporary, $Path, [NullString]::Value)
  } else {
    [IO.File]::Move($temporary, $Path)
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
  $map = @{}
  $prefix = ($Root.TrimEnd('\') + '\').Replace('\', '/').ToLowerInvariant()
  foreach ($file in @($data.testResults)) {
    if (-not $file) { continue }
    # Key by worktree-relative file and full name: the same name can occur in several files.
    $fileName = ([string]$file.name).Replace('\', '/')
    if ($fileName.ToLowerInvariant().StartsWith($prefix)) { $fileName = $fileName.Substring($prefix.Length) }
    foreach ($result in @($file.assertionResults)) {
      if (-not $result) { continue }
      $fullName = [string]$result.fullName
      if ($fullName) { $map[$fileName + ' > ' + $fullName] = [string]$result.status }
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
    [string]$RunDir
  )
  # Invoke-AsStandardUser takes an argv array, which a powershell.exe -File command line cannot
  # carry; a generated wrapper in the run dir passes it directly. The wrapper runs as a child
  # process, so Invoke-AsStandardUser's exit code does not end this run.
  $wrapperPath = Join-Path $RunDir ("standard-$Label.ps1")
  $wrapper = @"
# Tivano Windows - derived from Tivano (AGPL-3.0), modified 2026-11-10.
# Droppy Code by Jordy Spruit (Droppy), https://getdroppycode.app
# Generated for one run by Invoke-PrReview.ps1.
`$ErrorActionPreference = 'Stop'
`$Code = 0
try {
  & $(ConvertTo-PsLiteral $script:StandardScript) -CredentialFile $(ConvertTo-PsLiteral $StandardCredentialFile) -Evidence $(ConvertTo-PsLiteral $ChecksDir) -Command $(ConvertTo-PsLiteral $script:CmdExe) -Arguments @('/d', '/c', $(ConvertTo-PsLiteral $script:RunChecks), $(ConvertTo-PsLiteral $Worktree), $(ConvertTo-PsLiteral $ResultsDir)) -WorkingDirectory $(ConvertTo-PsLiteral $Worktree) -TimeoutSec 5400
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
  $null = $lines.Add('| Step | base | pr |')
  $null = $lines.Add('| --- | --- | --- |')
  foreach ($step in @('install', 'build', 'typecheck', 'unit', 'e2e')) {
    $baseValue = 'missing'
    $prValue = 'missing'
    if ($StepsBase -and $StepsBase.PSObject.Properties[$step]) { $baseValue = if ($null -eq $StepsBase.$step) { 'not run' } else { [string]$StepsBase.$step } }
    if ($StepsPr -and $StepsPr.PSObject.Properties[$step]) { $prValue = if ($null -eq $StepsPr.$step) { 'not run' } else { [string]$StepsPr.$step } }
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
      elseif ($ReportBase.map[$name] -eq 'passed') { $newFailures += $name }
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
}

function Build-PostBody {
  param([string]$Path, [string]$Sha7, [string]$Review, [string]$ChecksSummary)
  $header = '> Automated review by a coding agent (Devin CLI) on a Windows test machine, for head ' + $Sha7 +
    '. Agent self-tested; not a maintainer approval; the maintainers and the product owner decide on merging.'
  $body = $header + "`n`n" + $Review.TrimEnd() + "`n`n" +
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
    try { Remove-Item -LiteralPath $old.FullName -Recurse -Force -ErrorAction Stop } catch { $failed += ('cannot delete old run ' + $old.Name) }
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

  $WorkRoot = Get-AcceptancePath $Root
  Assert-OutsideGitCheckout $WorkRoot
  [IO.Directory]::CreateDirectory($WorkRoot) | Out-Null
  $script:WorkRoot = $WorkRoot

  # One pass at a time. A second start writes a skipped summary and leaves the first run alone.
  try {
    $lock = [IO.File]::Open((Join-Path $WorkRoot 'lock'), [IO.FileMode]::OpenOrCreate,
      [IO.FileAccess]::ReadWrite, [IO.FileShare]::None)
  } catch {
    $skippedOut += [ordered]@{ pr = $null; reason = 'another run holds the lock' }
    $ok = $true
  }

  if ($lock) {
    $Checkout = Get-AcceptancePath $Checkout
    if (-not (Test-Path -LiteralPath (Join-Path $Checkout '.git'))) { throw '-Checkout must be the root of a git clone.' }
    $standardPath = Get-AcceptancePath $script:StandardScript
    if (-not (Test-Path -LiteralPath $standardPath -PathType Leaf)) { throw 'Invoke-AsStandardUser.ps1 is missing; keep scripts\pr-review next to scripts\windows-acceptance.' }
    if (-not (Test-Path -LiteralPath $script:RunChecks -PathType Leaf)) { throw 'run-checks.cmd is missing.' }
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
    $state = Read-State $statePath
    Save-State $statePath $state

    $listPath = Join-Path $WorkRoot '.pr-list.json'
    $listCode = Invoke-Gh ('pr list -R ' + $Repo + ' --state open --limit 1000 --json number,headRefOid,isDraft,author,title,baseRefName') `
      $listPath (Join-Path $WorkRoot '.pr-list.err.json')
    if ($listCode -ne 0) { throw ('gh pr list failed: ' + (Get-Tail (Join-Path $WorkRoot '.pr-list.err.json') 5)) }
    # Windows PowerShell 5.1 emits a JSON array as one Object[]; unroll it.
    $pulls = @((Read-Text $listPath) | ConvertFrom-Json | ForEach-Object { $_ })

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
      if ($PrNumber -eq 0 -and ($entry.reviewed -contains $sha)) {
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
      [IO.Directory]::CreateDirectory($runDir) | Out-Null
      $worktrees = @()
      $prTree = $null
      try {
        $fetch = Invoke-Git ('fetch origin main +refs/pull/' + $number + '/head:refs/remotes/origin/pr-' + $number)
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
        [IO.Directory]::CreateDirectory($sandbox) | Out-Null
        $prTree = Join-Path $sandbox 'pr'
        $baseTree = Join-Path $sandbox 'base'
        $addPr = Invoke-Git ('worktree add --detach ' + (Quote-Argument $prTree) + ' ' + $sha)
        if ($addPr.exitCode -ne 0) { throw ('git worktree add (pr) failed: ' + $addPr.error) }
        $worktrees += $prTree
        $addBase = Invoke-Git ('worktree add --detach ' + (Quote-Argument $baseTree) + ' ' + $mergeBase)
        if ($addBase.exitCode -ne 0) { throw ('git worktree add (base) failed: ' + $addBase.error) }
        $worktrees += $baseTree

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
        $entry = Get-StateEntry $state ([string]$number)
        $previousAttempts = 0
        if ($entry.attempts.ContainsKey($sha)) { $previousAttempts = [int]$entry.attempts[$sha] }
        $entry.attempts[$sha] = $previousAttempts + 1
        Save-State $statePath $state

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
        $aclCode = Invoke-Tool $icacls `
          ((Quote-Argument $sandbox) + ' /grant "*' + $standardSid + ':(OI)(CI)M"') `
          (Join-Path $runDir 'acl.out.log') (Join-Path $runDir 'acl.err.log')
        if ($aclCode -ne 0) { throw ('icacls could not grant the standard account Modify on the run directory: ' + (Get-Tail (Join-Path $runDir 'acl.err.log') 5)) }

        $checksBase = Join-Path $sandbox 'checks-base'
        $checksPr = Join-Path $sandbox 'checks-pr'
        $resultsBase = Join-Path $runDir 'results-base'
        $resultsPr = Join-Path $runDir 'results-pr'
        # Base runs first and its results are copied out before any PR code runs.
        $standardBase = Invoke-StandardChecks 'base' $checksBase (Join-Path $sandbox 'results-base') $baseTree $runDir
        Copy-RunOutput (Join-Path $sandbox 'results-base') $resultsBase
        Copy-RunOutput $checksBase (Join-Path $runDir 'checks-base')
        $standardPr = Invoke-StandardChecks 'pr' $checksPr (Join-Path $sandbox 'results-pr') $prTree $runDir
        Copy-RunOutput (Join-Path $sandbox 'results-pr') $resultsPr
        Copy-RunOutput $checksPr (Join-Path $runDir 'checks-pr')
        $standardBase.summary = Get-StandardSummary (Join-Path $runDir 'checks-base')
        $standardPr.summary = Get-StandardSummary (Join-Path $runDir 'checks-pr')

        $stepsBase = Get-Steps (Join-Path $resultsBase 'steps.json')
        $stepsPr = Get-Steps (Join-Path $resultsPr 'steps.json')
        $reportBase = Get-VitestReport (Join-Path $resultsBase 'vitest.json') $baseTree
        $reportPr = Get-VitestReport (Join-Path $resultsPr 'vitest.json') $prTree
        $checksSummaryPath = Join-Path $runDir 'checks-summary.md'
        Write-ChecksSummary $checksSummaryPath $runDir 'base' 'pr' $stepsBase $stepsPr $reportBase $reportPr $standardBase $standardPr

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
        foreach ($stale in @($reviewPath, (Join-Path $runDir 'review.zh.md'))) { Remove-Item -LiteralPath $stale -Force -ErrorAction SilentlyContinue }
        $agentStart = [DateTime]::UtcNow
        $devinResult = Invoke-Devin $runDir $prTree $promptPath $devinLog
        if ($devinResult -ne 'exitCode 0') {
          # A timed-out or failed agent may leave a partial review; never post it.
          $errorsOut += [ordered]@{ pr = $number; error = 'Devin CLI ' + $devinResult + '; nothing posted' }
          continue
        }
        if (-not (Test-Path -LiteralPath $reviewPath -PathType Leaf) -or
            (Get-Item -LiteralPath $reviewPath).LastWriteTimeUtc -lt $agentStart) {
          $errorsOut += [ordered]@{ pr = $number; error = 'no fresh review.md was written; nothing posted' }
          continue
        }

        $reviewText = Read-Text $reviewPath
        if ([string]::IsNullOrWhiteSpace($reviewText)) {
          $errorsOut += [ordered]@{ pr = $number; error = 'no review.md was written; nothing posted' }
          continue
        }

        $bodyPath = Join-Path $runDir 'post-body.md'
        Build-PostBody $bodyPath $sha7 $reviewText (Read-Text $checksSummaryPath)
        $posted = $false
        if (-not $DryRun) {
          $postCode = Invoke-Gh ('pr review ' + $number + ' -R ' + $Repo + ' --comment --body-file ' + (Quote-Argument $bodyPath)) `
            (Join-Path $runDir 'post.out.log') (Join-Path $runDir 'post.err.log')
          if ($postCode -ne 0) {
            $errorsOut += [ordered]@{ pr = $number; error = 'gh pr review failed: ' + (Get-Tail (Join-Path $runDir 'post.err.log') 5) }
            continue
          }
          $posted = $true
          $entry = Get-StateEntry $state ([string]$number)
          $reviewed = @($entry.reviewed)
          if ($reviewed -notcontains $sha) { $reviewed += $sha }
          $entry.reviewed = $reviewed
          Save-State $statePath $state
        }
        $reviewedOut += [ordered]@{ pr = $number; sha = $sha; posted = $posted; runDir = $runDir }
      } catch {
        $errorsOut += [ordered]@{ pr = $number; error = $_.Exception.Message }
      } finally {
        if ($script:GitPath) {
          foreach ($tree in $worktrees) { $null = Invoke-Git ('worktree remove --force ' + (Quote-Argument $tree)) }
          $null = Invoke-Git 'worktree prune'
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
# Per-PR failures are recorded in errors; only a run-level failure is a nonzero exit.
if ($ok) { exit 0 }
exit 1
