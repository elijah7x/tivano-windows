# Tivano Windows - derived from Tivano (AGPL-3.0), modified 2026-11-16.
# Droppy Code by Jordy Spruit (Droppy), https://getdroppycode.app
# Usage: .\Start-DevinAutopilot.ps1 (-Kickoff | -Watch | -Register | -Unregister) [-Root <state root>] [-Workspace <repo checkout>] [-Repo <owner/name>] [-Label <label>] [-IdleMinutes <min>] [-ApprovalMinutes <min>] [-UserIdleSeconds <sec>] [-IntervalMinutes <min>]
# Launches and watches a single Devin Desktop autopilot chat following autopilot.md.

param(
  [switch]$Kickoff,
  [switch]$Watch,
  [switch]$Register,
  [switch]$Unregister,
  [string]$Root = 'C:\tivano\dev-loop',
  [string]$Workspace = 'C:\tivano\dev-loop\repo',
  [string]$Repo = 'elijah7x/tivano-windows',
  [ValidatePattern('^[A-Za-z0-9_.-]+$')][string]$Label = 'nyx-auto',
  [ValidateRange(5, 240)][int]$IdleMinutes = 25,
  [ValidateRange(1, 240)][int]$ApprovalMinutes = 3,
  [ValidateRange(0, 3600)][int]$UserIdleSeconds = 120,
  [ValidateRange(1, 1440)][int]$IntervalMinutes = 15
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$script:TaskPath = '\TivanoDevLoop\'
$script:TaskName = 'autopilot'
$script:PromptPath = Join-Path $PSScriptRoot 'autopilot.md'
$script:AcceptanceRepo = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..')).TrimEnd('\')
$script:PowerShellExe = Join-Path ([Environment]::GetFolderPath('System')) 'WindowsPowerShell\v1.0\powershell.exe'

$script:WorkRoot = $null
$script:WorkspacePath = $null
$script:LogsDir = $null
$script:LogPath = $null
$script:AutopilotDir = $null
$script:StateDir = $null
$script:StopPath = $null
$script:ProgressPath = $null
$script:WatchdogPath = $null
$script:GhPath = $null
$script:DevinPath = $null
$script:Redactions = @()
$script:GuiTypesLoaded = $false

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
      throw "$Path is inside a git checkout ($part). Keep autopilot state and logs outside any checkout."
    }
    $parent = Split-Path -Parent $part
    if (-not $parent -or $parent -eq $part) { break }
    $part = $parent
  }
}

function Assert-AcceptanceOutsideRepo {
  param([string]$Path, [string[]]$Repositories = @($script:AcceptanceRepo))
  foreach ($repository in $Repositories) {
    $repoFull = Get-AcceptancePath $repository
    if ($Path.Equals($repoFull, [StringComparison]::OrdinalIgnoreCase) -or
        $Path.StartsWith($repoFull + '\', [StringComparison]::OrdinalIgnoreCase)) {
      throw 'Autopilot state and logs must be outside the repository.'
    }
  }
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

function Get-JsonProp {
  param($Object, [string]$Name)
  if ($null -eq $Object) { return $null }
  if ($Object.PSObject.Properties[$Name]) { return $Object.$Name }
  return $null
}

function Get-LabelNames {
  param($Labels)
  if ($null -eq $Labels) { return @() }
  return @($Labels | ForEach-Object { [string](Get-JsonProp $_ 'name') } | Where-Object { $_ })
}

function Protect-PublicText {
  param([AllowEmptyString()][string]$Text)
  if ([string]::IsNullOrEmpty($Text)) { return '' }
  $result = $Text
  foreach ($secret in $script:Redactions) {
    $result = [regex]::Replace($result, [regex]::Escape($secret), '<redacted>', [Text.RegularExpressions.RegexOptions]::IgnoreCase)
  }
  return $result
}

function Test-Stop {
  return ($null -ne $script:StopPath -and (Test-Path -LiteralPath $script:StopPath))
}

# Raw-byte redirection: gh writes UTF-8, which PowerShell 5.1 would otherwise decode with the console code page.
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

# Runs from the state root, which is never a git checkout, so gh never reads repository context from the cwd.
function Invoke-Gh {
  param([string]$Arguments)
  $out = Join-Path $script:AutopilotDir '.gh.out.tmp'
  $err = Join-Path $script:AutopilotDir '.gh.err.tmp'
  for ($try = 1; ; $try++) {
    $code = Invoke-Tool $script:GhPath $Arguments $out $err $script:WorkRoot
    $result = [pscustomobject]@{ exitCode = $code; text = (Read-Text $out); error = (Read-Text $err) }
    if ($code -eq 0 -or $try -ge 4 -or -not (Test-NetworkFailure $result.error)) { return $result }
    Write-Log ('gh network failure, retry ' + $try + '/3: ' + (ConvertTo-SingleLine ([string]$result.error) 160))
    Start-Sleep -Seconds (20 * $try)
  }
}

function Initialize-GuiTypes {
  if ($script:GuiTypesLoaded) { return }
  Add-Type -AssemblyName System.Windows.Forms
  Add-Type -TypeDefinition @'
using System; using System.Text; using System.Runtime.InteropServices;
public static class DevLoopWindows {
  delegate bool EnumProc(IntPtr h, IntPtr p);
  [StructLayout(LayoutKind.Sequential)]
  struct LASTINPUTINFO {
    public uint cbSize;
    public uint dwTime;
  }
  [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc cb, IntPtr p);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] static extern bool GetLastInputInfo(ref LASTINPUTINFO plii);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int c);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern void keybd_event(byte k, byte s, uint f, UIntPtr e);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern void mouse_event(uint f, uint dx, uint dy, uint d, UIntPtr e);
  // Devin Desktop titles a window "<folder> - Devin" or "<session title> <folder> - Devin", plus " - <open editor>" when a file is open.
  public static IntPtr Find(string folder) {
    IntPtr found = IntPtr.Zero;
    string bare = folder + " - Devin", tail = " " + bare;
    EnumWindows((h, p) => {
      if (!IsWindowVisible(h)) return true;
      var sb = new StringBuilder(1024); GetWindowText(h, sb, 1024); var t = sb.ToString();
      if (t == bare || t.EndsWith(tail, StringComparison.Ordinal) || t.StartsWith(bare + " - ", StringComparison.Ordinal) || t.Contains(tail + " - ")) { found = h; return false; }
      return true;
    }, IntPtr.Zero);
    return found;
  }
  public static double GetUserIdleSeconds() {
    var info = new LASTINPUTINFO();
    info.cbSize = (uint)Marshal.SizeOf(typeof(LASTINPUTINFO));
    if (!GetLastInputInfo(ref info)) return 0.0;
    uint now = unchecked((uint)Environment.TickCount);
    uint elapsedMs = unchecked(now - info.dwTime);
    return elapsedMs / 1000.0;
  }
}
'@
  $script:GuiTypesLoaded = $true
}

function Test-DevinForeground {
  param([IntPtr]$Window)
  return ($Window -ne [IntPtr]::Zero -and [DevLoopWindows]::GetForegroundWindow() -eq $Window)
}

function Set-DevinForeground {
  param([IntPtr]$Window)
  if ($Window -eq [IntPtr]::Zero) { return $false }
  [DevLoopWindows]::ShowWindow($Window, 9) | Out-Null
  # A tap of Alt lets a background process take the foreground.
  [DevLoopWindows]::keybd_event(0x12, 0, 0, [UIntPtr]::Zero); [DevLoopWindows]::keybd_event(0x12, 0, 2, [UIntPtr]::Zero)
  [DevLoopWindows]::SetForegroundWindow($Window) | Out-Null
  Start-Sleep -Milliseconds 800
  return (Test-DevinForeground $Window)
}

# Keyboard shortcuts toggle the chat panel or land in an open editor depending on what had focus, so the
# chat input is clicked instead: maximized, it is the box at the bottom of the right-hand Devin panel.
# No Ctrl+A/Delete afterwards: if the click ever lands in an editor, a paste is recoverable, a wipe is not.
function Focus-DevinChatInput {
  param([IntPtr]$Window)
  if (-not (Set-DevinForeground $Window)) { return $false }
  [DevLoopWindows]::ShowWindow($Window, 3) | Out-Null
  Start-Sleep -Milliseconds 800
  if (-not (Test-DevinForeground $Window)) { return $false }
  $rect = New-Object DevLoopWindows+RECT
  if (-not [DevLoopWindows]::GetWindowRect($Window, [ref]$rect)) { return $false }
  $width = $rect.Right - $rect.Left
  $height = $rect.Bottom - $rect.Top
  $x = [int]($rect.Right - $width * 0.1125)
  $y = [int]($rect.Bottom - $height * 0.124)
  [DevLoopWindows]::SetCursorPos($x, $y) | Out-Null
  Start-Sleep -Milliseconds 200
  [DevLoopWindows]::mouse_event(0x0002, 0, 0, 0, [UIntPtr]::Zero)
  [DevLoopWindows]::mouse_event(0x0004, 0, 0, 0, [UIntPtr]::Zero)
  Start-Sleep -Milliseconds 600
  return (Test-DevinForeground $Window)
}

function Send-DevinKeysSafe {
  param([IntPtr]$Window, [string]$Keys)
  if (-not (Test-DevinForeground $Window)) { return $false }
  [Windows.Forms.SendKeys]::SendWait($Keys)
  return $true
}

function Send-DevinTextSafe {
  param([IntPtr]$Window, [string]$Text)
  if (-not (Test-DevinForeground $Window)) { return $false }
  [Windows.Forms.Clipboard]::SetText($Text)
  Start-Sleep -Milliseconds 300
  if (-not (Test-DevinForeground $Window)) { return $false }
  [Windows.Forms.SendKeys]::SendWait('^v')
  Start-Sleep -Milliseconds 800
  if (-not (Test-DevinForeground $Window)) { return $false }
  [Windows.Forms.SendKeys]::SendWait('{ENTER}')
  return $true
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

# Windows does not refresh LastWriteTime while Devin holds a log open for appending, so logs are picked
# by creation time (a desktop session can run for days) and activity is read from the line timestamps.
function Get-DevinLogFiles {
  param([string]$Logs)
  $cutoff = [DateTime]::Now.AddDays(-7)
  return @(Get-ChildItem -LiteralPath $Logs -Filter 'devin_*.log' -File -ErrorAction SilentlyContinue |
    Where-Object { $_.CreationTime -ge $cutoff })
}

function Wait-DevinBypass {
  param([DateTime]$Since, [int]$Seconds)
  $logs = Join-Path ([Environment]::GetFolderPath('ApplicationData')) 'Devin\cli\logs'
  $deadline = [DateTime]::Now.AddSeconds($Seconds)
  $styles = [Globalization.DateTimeStyles]::AssumeUniversal -bor [Globalization.DateTimeStyles]::AdjustToUniversal
  $sinceUtc = $Since.ToUniversalTime().AddSeconds(-1)
  while ([DateTime]::Now -lt $deadline) {
    Start-Sleep -Seconds 2
    if (-not (Test-Path -LiteralPath $logs -PathType Container)) { continue }
    $files = Get-DevinLogFiles $logs
    foreach ($file in $files) {
      foreach ($line in (Read-LogLinesShared $file.FullName)) {
        if ($line -notmatch 'handle_slash_command_on_chain:apply_mode_change|ModeChange\(Bypass\)') { continue }
        if ($line -notmatch '^(\S+Z)(?:\s|$)') { continue }
        $parsed = [DateTime]::MinValue
        if ([DateTime]::TryParse($Matches[1], [Globalization.CultureInfo]::InvariantCulture, $styles, [ref]$parsed)) {
          if ($parsed -ge $sinceUtc) { return $true }
        }
      }
    }
  }
  return $false
}

function Send-DevinBypassCommandSafe {
  param([IntPtr]$Window)
  if (-not (Set-DevinForeground $Window)) { return $false }
  if (-not (Focus-DevinChatInput $Window)) { return $false }
  $modeSince = [DateTime]::Now
  if (-not (Send-DevinTextSafe $Window '/bypass')) { return $false }
  if (-not (Send-DevinKeysSafe $Window '{ENTER}')) { return $false }
  return (Wait-DevinBypass $modeSince 20)
}

function Get-DevinLogActivity {
  param([DateTime]$SinceUtc)
  $logs = Join-Path ([Environment]::GetFolderPath('ApplicationData')) 'Devin\cli\logs'
  $newestWriteUtc = $null
  $oldestPendingUtc = $null
  if (-not (Test-Path -LiteralPath $logs -PathType Container)) {
    return [pscustomobject]@{ newestWriteUtc = $null; pendingApprovalUtc = $null }
  }
  $files = Get-DevinLogFiles $logs
  $styles = [Globalization.DateTimeStyles]::AssumeUniversal -bor [Globalization.DateTimeStyles]::AdjustToUniversal
  foreach ($file in $files) {
    $filePendingUtc = $null
    foreach ($line in (Read-LogLinesShared $file.FullName)) {
      if ($line -notmatch '^(\S+Z)(?:\s|$)') { continue }
      $parsed = [DateTime]::MinValue
      if (-not [DateTime]::TryParse($Matches[1], [Globalization.CultureInfo]::InvariantCulture, $styles, [ref]$parsed)) { continue }
      if ($parsed -lt $SinceUtc) { continue }
      if ($null -eq $newestWriteUtc -or $parsed -gt $newestWriteUtc) { $newestWriteUtc = $parsed }
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

function Read-WatchdogState {
  $state = [ordered]@{
    trackingIssue = 0
    lastKickoffUtc = ''
    firstSeenUtc = ''
    lastSeenLogWriteUtc = ''
    lastNudgeUtc = ''
    lastNudgeReason = ''
    lastNudgeLogWriteUtc = ''
    consecutiveNudges = 0
    totalNudges = 0
    stuckNotified = $false
    nudges = @()
  }
  $data = Read-JsonFile $script:WatchdogPath
  if (-not $data) { return $state }
  foreach ($key in @('lastKickoffUtc', 'firstSeenUtc', 'lastSeenLogWriteUtc', 'lastNudgeUtc', 'lastNudgeReason', 'lastNudgeLogWriteUtc')) {
    $val = Get-JsonProp $data $key
    if ($null -ne $val) { $state[$key] = [string]$val }
  }
  foreach ($key in @('trackingIssue', 'consecutiveNudges', 'totalNudges')) {
    $val = Get-JsonProp $data $key
    if ($null -ne $val) { $state[$key] = [int]$val }
  }
  $stuckVal = Get-JsonProp $data 'stuckNotified'
  if ($null -ne $stuckVal) { $state['stuckNotified'] = [bool]$stuckVal }
  $nudgesVal = Get-JsonProp $data 'nudges'
  if ($null -ne $nudgesVal) { $state['nudges'] = @($nudgesVal | ForEach-Object { $_ }) }
  return $state
}

function Save-WatchdogState {
  param($State)
  $temporary = $script:WatchdogPath + '.tmp'
  Write-Text $temporary ((ConvertTo-Json -InputObject $State -Depth 6) + "`n")
  if (Test-Path -LiteralPath $script:WatchdogPath) {
    [IO.File]::Replace($temporary, $script:WatchdogPath, [NullString]::Value)
  } else {
    [IO.File]::Move($temporary, $script:WatchdogPath)
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

function Test-WorkRemains {
  $result = Invoke-Gh ('issue list -R ' + $Repo + ' --state open --label ' + $Label + ' --limit 200 --json number,labels')
  if ($result.exitCode -ne 0) {
    Write-Log ('gh issue list failed: ' + (Get-ErrorSummary $result))
    return $null
  }
  if ([string]::IsNullOrWhiteSpace($result.text)) { return $false }
  try {
    $issues = @($result.text | ConvertFrom-Json | ForEach-Object { $_ })
  } catch {
    Write-Log ('could not parse gh issue list JSON: ' + $_.Exception.Message)
    return $null
  }
  foreach ($issue in $issues) {
    $names = @(Get-LabelNames (Get-JsonProp $issue 'labels'))
    if ($names -notcontains 'needs-human') { return $true }
  }
  return $false
}

function Resolve-TrackingIssue {
  param($State)
  $cached = [int]$State['trackingIssue']
  if ($cached -gt 0) {
    $view = Invoke-Gh ('issue view ' + $cached + ' -R ' + $Repo + ' --json number,state')
    if ($view.exitCode -eq 0 -and -not [string]::IsNullOrWhiteSpace($view.text)) {
      try {
        $parsedView = $view.text | ConvertFrom-Json
        if ([string](Get-JsonProp $parsedView 'state') -eq 'OPEN') { return $cached }
      } catch { }
    }
    $State['trackingIssue'] = 0
    Save-WatchdogState $State
  }

  $title = 'Automated dev loop: progress log'
  $search = Invoke-Gh ('issue list -R ' + $Repo + ' --state open --search ' + (Quote-Argument ($title + ' in:title')) + ' --limit 20 --json number,title')
  if ($search.exitCode -ne 0) {
    Write-Log ('could not search tracking issue: ' + (Get-ErrorSummary $search))
    return 0
  }
  $number = 0
  if (-not [string]::IsNullOrWhiteSpace($search.text)) {
    try {
      $items = @($search.text | ConvertFrom-Json | ForEach-Object { $_ })
      $exact = @($items | Where-Object { [string](Get-JsonProp $_ 'title') -ceq $title } | Sort-Object { [int](Get-JsonProp $_ 'number') })
      if ($exact.Count -gt 0) { $number = [int](Get-JsonProp $exact[0] 'number') }
    } catch { }
  }
  if ($number -gt 0) {
    $State['trackingIssue'] = $number
    Save-WatchdogState $State
  }
  return $number
}

function Send-StuckTrackingComment {
  param($State)
  $issueNo = Resolve-TrackingIssue $State
  if ($issueNo -le 0) {
    Write-Log 'could not locate open tracking issue to report stuck autopilot'
    return $false
  }
  $stamp = [DateTime]::Now.ToString('yyyy-MM-ddTHH:mm:ssK')
  $message = 'Autopilot chat looks stuck after 6 consecutive nudges with no new agent log activity and needs a person.'
  $clean = ConvertTo-SingleLine (Protect-PublicText $message) 500
  $bodyPath = Join-Path $script:AutopilotDir ('tracking-stuck-' + [Guid]::NewGuid().ToString('N').Substring(0, 8) + '.md')
  try {
    Write-Text $bodyPath ($stamp + ' ' + $clean + "`n")
    $result = Invoke-Gh ('issue comment ' + $issueNo + ' -R ' + $Repo + ' --body-file ' + (Quote-Argument $bodyPath))
    if ($result.exitCode -ne 0) {
      Write-Log ('could not comment on tracking issue #' + $issueNo + ': ' + (Get-ErrorSummary $result))
      return $false
    }
    Write-Log ('posted stuck notification to tracking issue #' + $issueNo)
    return $true
  } finally {
    Remove-Item -LiteralPath $bodyPath -Force -ErrorAction SilentlyContinue
  }
}

function Register-WatchdogNudge {
  param($State, [string]$Reason, $LogWriteUtc, [DateTime]$NowUtc)
  $State['consecutiveNudges'] = [int]$State['consecutiveNudges'] + 1
  $State['totalNudges'] = [int]$State['totalNudges'] + 1
  $State['lastNudgeUtc'] = $NowUtc.ToString('o')
  $State['lastNudgeReason'] = $Reason
  $logWriteText = if ($null -ne $LogWriteUtc) { $LogWriteUtc.ToString('o') } else { '' }
  $State['lastNudgeLogWriteUtc'] = $logWriteText
  $history = New-Object Collections.Generic.List[object]
  foreach ($item in @($State['nudges'])) { $null = $history.Add($item) }
  $null = $history.Add([ordered]@{ atUtc = $NowUtc.ToString('o'); reason = $Reason; logWriteUtc = $logWriteText })
  if ($history.Count -gt 50) {
    $State['nudges'] = @($history.GetRange($history.Count - 50, 50))
  } else {
    $State['nudges'] = @($history)
  }
  Save-WatchdogState $State

  if ([int]$State['consecutiveNudges'] -ge 6 -and -not [bool]$State['stuckNotified']) {
    if (Send-StuckTrackingComment $State) {
      $State['stuckNotified'] = $true
      Save-WatchdogState $State
    }
  }
}

function Resolve-DevinLauncher {
  if ($script:DevinPath) { return $script:DevinPath }
  $devin = Get-Command -Name 'devin' -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
  if (-not $devin) { throw 'Devin CLI was not found on PATH; install it and sign in as the operating account.' }
  $script:DevinPath = $devin.Source
  return $script:DevinPath
}

function Invoke-Kickoff {
  param([bool]$WaitForIdle)
  if (-not (Test-Path -LiteralPath $script:PromptPath -PathType Leaf)) { throw 'autopilot.md is missing next to this script.' }
  if (-not (Test-Path -LiteralPath $script:WorkspacePath -PathType Container)) { throw '-Workspace does not exist.' }
  if (Test-Stop) { Write-Log 'STOP file present; kickoff exiting'; return 'deferred' }
  Initialize-GuiTypes

  $folder = Split-Path -Leaf $script:WorkspacePath
  $window = [DevLoopWindows]::Find($folder)
  $openedNow = $false
  if ($window -eq [IntPtr]::Zero) {
    $devinExe = Resolve-DevinLauncher
    Write-Log ('launching Devin Desktop for ' + $folder)
    $null = Start-Process -FilePath $devinExe -ArgumentList ('desktop ' + (Quote-Argument $script:WorkspacePath)) -WindowStyle Hidden
    for ($i = 0; $i -lt 90 -and $window -eq [IntPtr]::Zero; $i++) {
      Start-Sleep -Seconds 1
      $window = [DevLoopWindows]::Find($folder)
    }
    if ($window -eq [IntPtr]::Zero) {
      Write-Log ('gui: no Devin Desktop window for ' + $folder + ' within 90s')
      return 'failed'
    }
    $openedNow = $true
  }

  if ($WaitForIdle) {
    $idleDeadline = [DateTime]::UtcNow.AddMinutes(30)
    while ([DevLoopWindows]::GetUserIdleSeconds() -lt $UserIdleSeconds) {
      if (Test-Stop) { Write-Log 'STOP file present; kickoff exiting'; return 'deferred' }
      if ([DateTime]::UtcNow -ge $idleDeadline) {
        Write-Log ('user active for 30m (need ' + $UserIdleSeconds + 's idle); kickoff exiting')
        return 'deferred'
      }
      Start-Sleep -Seconds 5
    }
  }

  if ($openedNow) { Start-Sleep -Seconds 8 }
  $window = [DevLoopWindows]::Find($folder)
  if ($window -eq [IntPtr]::Zero) {
    Write-Log ('gui: Devin Desktop window for ' + $folder + ' disappeared before send')
    return 'failed'
  }

  $message = 'Read the file ' + $script:PromptPath + ' and carry it out exactly as written. Work through the whole queue without asking questions. Re-read that file after every issue. Use these values wherever the file names its defaults: repository ' + $Repo + ', label ' + $Label + ', root folder ' + $script:WorkRoot + ' (progress.json in its autopilot subfolder, STOP in its state subfolder).'
  $sent = $false
  for ($try = 0; $try -lt 3 -and -not $sent; $try++) {
    $window = [DevLoopWindows]::Find($folder)
    if ($window -eq [IntPtr]::Zero) { Start-Sleep -Seconds 2; continue }
    if (-not (Set-DevinForeground $window)) {
      Write-Log ('kickoff try ' + ($try + 1) + '/3: could not focus Devin window')
      Start-Sleep -Seconds 2
      continue
    }
    if (Test-Stop) { Write-Log 'STOP file present; kickoff exiting'; return 'deferred' }
    if (-not (Send-DevinBypassCommandSafe $window)) {
      Write-Log ('kickoff try ' + ($try + 1) + '/3: /bypass failed or focus changed')
      Start-Sleep -Seconds 2
      continue
    }
    if (-not (Set-DevinForeground $window)) {
      Write-Log ('kickoff try ' + ($try + 1) + '/3: lost focus after /bypass')
      Start-Sleep -Seconds 2
      continue
    }
    if (-not (Focus-DevinChatInput $window)) {
      Write-Log ('kickoff try ' + ($try + 1) + '/3: focus changed before clearing input')
      Start-Sleep -Seconds 2
      continue
    }
    if (-not (Send-DevinTextSafe $window $message)) {
      Write-Log ('kickoff try ' + ($try + 1) + '/3: focus changed before pasting prompt')
      Start-Sleep -Seconds 2
      continue
    }
    $sent = $true
  }

  if (-not $sent) {
    Write-Log 'kickoff failed: Devin Desktop chat did not take /bypass or focus changed'
    return 'failed'
  }

  $watchdog = Read-WatchdogState
  $watchdog['lastKickoffUtc'] = [DateTime]::UtcNow.ToString('o')
  $watchdog['consecutiveNudges'] = 0
  $watchdog['stuckNotified'] = $false
  Save-WatchdogState $watchdog
  Write-Log ('kickoff sent autopilot prompt to Devin Desktop window "' + $folder + '"')
  return 'ok'
}

function Invoke-WatchTick {
  if (Test-Stop) { return }
  if (-not (Test-Path -LiteralPath $script:PromptPath -PathType Leaf)) { throw 'autopilot.md is missing next to this script.' }
  if (-not (Test-Path -LiteralPath $script:WorkspacePath -PathType Container)) { throw '-Workspace does not exist.' }

  $env:GH_PROMPT_DISABLED = '1'
  $env:GH_NO_UPDATE_NOTIFIER = '1'
  $env:GIT_TERMINAL_PROMPT = '0'
  $env:GCM_INTERACTIVE = 'never'

  $gh = Get-Command -Name 'gh' -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
  if (-not $gh) { throw 'GitHub CLI (gh) was not found on PATH.' }
  $script:GhPath = $gh.Source

  $workChecked = $false
  $workRemains = $true
  $progress = Read-JsonFile $script:ProgressPath
  if ($progress) {
    $pState = ([string](Get-JsonProp $progress 'state')).Trim().ToLowerInvariant()
    $pStep = ([string](Get-JsonProp $progress 'step')).Trim()
    $pUpdatedAt = ([string](Get-JsonProp $progress 'updatedAt')).Trim()
    if ($pState -eq 'done') {
      $workRemains = Test-WorkRemains
      $workChecked = $true
      if ($null -eq $workRemains) { return }
      if (-not $workRemains) {
        Write-Log ('progress state is done and no open ' + $Label + ' issues without needs-human remain; exiting')
        return
      }
    } elseif ($pState -eq 'idle' -and $pStep -match '(?i)daily merge cap') {
      $parsedUpdated = [DateTimeOffset]::MinValue
      if ([DateTimeOffset]::TryParse($pUpdatedAt, [Globalization.CultureInfo]::InvariantCulture, [Globalization.DateTimeStyles]::AssumeLocal, [ref]$parsedUpdated)) {
        if ($parsedUpdated.LocalDateTime.ToString('yyyy-MM-dd') -eq [DateTime]::Now.ToString('yyyy-MM-dd')) {
          Write-Log 'progress is idle on daily merge cap for today; exiting'
          return
        }
      }
      $workRemains = Test-WorkRemains
      $workChecked = $true
      if ($null -eq $workRemains) { return }
      if (-not $workRemains) {
        Write-Log ('daily merge cap date changed but no open ' + $Label + ' issues without needs-human remain; exiting')
        return
      }
    }
  }

  $nowUtc = [DateTime]::UtcNow
  $watchdog = Read-WatchdogState
  $sinceUtc = Parse-UtcTimestamp ([string]$watchdog['lastKickoffUtc'])
  if ($null -eq $sinceUtc) { $sinceUtc = $nowUtc.AddHours(-24) }

  $activity = Get-DevinLogActivity $sinceUtc
  $lastNudgeLogUtc = Parse-UtcTimestamp ([string]$watchdog['lastNudgeLogWriteUtc'])
  $lastNudgeUtc = Parse-UtcTimestamp ([string]$watchdog['lastNudgeUtc'])
  $activityResumed = $false
  if ($null -ne $activity.newestWriteUtc) {
    if ($null -ne $lastNudgeLogUtc) {
      if ($activity.newestWriteUtc -gt $lastNudgeLogUtc) { $activityResumed = $true }
    } elseif ($null -ne $lastNudgeUtc) {
      if ($activity.newestWriteUtc -gt $lastNudgeUtc) { $activityResumed = $true }
    }
    $watchdog['lastSeenLogWriteUtc'] = $activity.newestWriteUtc.ToString('o')
  }
  if ($activityResumed) {
    Write-Log 'Devin log activity resumed; resetting watchdog nudge counter'
    $watchdog['consecutiveNudges'] = 0
    $watchdog['stuckNotified'] = $false
  }
  if ([string]::IsNullOrWhiteSpace([string]$watchdog['firstSeenUtc'])) {
    $watchdog['firstSeenUtc'] = $nowUtc.ToString('o')
  }
  Save-WatchdogState $watchdog

  Initialize-GuiTypes
  $userIdleSec = [DevLoopWindows]::GetUserIdleSeconds()
  if ($userIdleSec -lt $UserIdleSeconds) {
    Write-Log ('user active, deferred (idle ' + [Math]::Round($userIdleSec, 1) + 's < ' + $UserIdleSeconds + 's)')
    return
  }

  $folder = Split-Path -Leaf $script:WorkspacePath
  $window = [DevLoopWindows]::Find($folder)
  if ($window -eq [IntPtr]::Zero) {
    if ([bool]$watchdog['stuckNotified']) {
      Write-Log 'no Devin window, but stuckNotified is true; waiting for human or log activity'
      return
    }
    if (-not $workChecked) {
      $workRemains = Test-WorkRemains
      $workChecked = $true
      if ($null -eq $workRemains) { return }
      if (-not $workRemains) {
        Write-Log ('no Devin window and no open ' + $Label + ' issues without needs-human; exiting')
        return
      }
    }
    Write-Log 'no Devin Desktop window open; running kickoff'
    $null = Invoke-Kickoff -WaitForIdle $false
    return
  }

  if ([bool]$watchdog['stuckNotified']) {
    Write-Log 'autopilot stuck (already notified); waiting for log activity to resume'
    return
  }
  if ([int]$watchdog['consecutiveNudges'] -ge 6) {
    if (Send-StuckTrackingComment $watchdog) {
      $watchdog['stuckNotified'] = $true
      Save-WatchdogState $watchdog
    }
    return
  }

  if ($null -ne $activity.pendingApprovalUtc) {
    $pendingMin = ($nowUtc - $activity.pendingApprovalUtc).TotalMinutes
    if ($pendingMin -ge $ApprovalMinutes) {
      Write-Log ('approval pending for ' + [Math]::Round($pendingMin, 1) + 'm (>= ' + $ApprovalMinutes + 'm); recovering /bypass')
      if (-not (Set-DevinForeground $window)) {
        Write-Log 'approval recovery aborted: could not focus Devin window'
        return
      }
      if (-not (Send-DevinBypassCommandSafe $window)) {
        Write-Log 'approval recovery aborted: /bypass not confirmed or focus changed'
        return
      }
      if (-not (Set-DevinForeground $window)) {
        Write-Log 'approval recovery aborted: lost focus after /bypass'
        return
      }
      if (-not (Focus-DevinChatInput $window)) {
        Write-Log 'approval recovery aborted: focus changed before clear'
        return
      }
      if (-not (Send-DevinTextSafe $window 'Bypass mode is on again. Continue the autopilot task from progress.json.')) {
        Write-Log 'approval recovery aborted: focus changed before paste'
        return
      }
      Register-WatchdogNudge $watchdog 'approval' $activity.newestWriteUtc $nowUtc
      Write-Log ('sent approval recovery nudge (' + $watchdog['consecutiveNudges'] + '/6)')
      return
    }
  }

  $baselineUtc = $activity.newestWriteUtc
  if ($null -eq $baselineUtc) { $baselineUtc = Parse-UtcTimestamp ([string]$watchdog['lastKickoffUtc']) }
  if ($null -eq $baselineUtc) { $baselineUtc = Parse-UtcTimestamp ([string]$watchdog['firstSeenUtc']) }
  if ($null -eq $baselineUtc) { $baselineUtc = $nowUtc }

  $idleMin = ($nowUtc - $baselineUtc).TotalMinutes
  if ($idleMin -ge $IdleMinutes) {
    if (-not $workChecked) {
      $workRemains = Test-WorkRemains
      $workChecked = $true
      if ($null -eq $workRemains) { return }
    }
    if (-not $workRemains) {
      Write-Log ('no log write for ' + [Math]::Round($idleMin, 1) + 'm, but no open ' + $Label + ' issues without needs-human remain; idle')
      return
    }
    # A long npm run verify or gate run writes nothing to Devin's log; the agent is busy, not stuck.
    $busy = @(Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | Where-Object {
      $_.CommandLine -and ($_.CommandLine -like ('*' + (Join-Path $Root 'work') + '*') -or $_.CommandLine -match 'Invoke-AutopilotGate|Invoke-PrReview')
    })
    if ($busy.Count -gt 0) {
      Write-Log ('no log write for ' + [Math]::Round($idleMin, 1) + 'm, but ' + $busy.Count + ' task process(es) are running; not nudging')
      return
    }
    Write-Log ('no log write for ' + [Math]::Round($idleMin, 1) + 'm (>= ' + $IdleMinutes + 'm) while work remains; nudging')
    if (-not (Set-DevinForeground $window)) {
      Write-Log 'idle nudge aborted: could not focus Devin window'
      return
    }
    if (-not (Focus-DevinChatInput $window)) {
      Write-Log 'idle nudge aborted: focus changed before clear'
      return
    }
    $nudgeMessage = 'Continue the autopilot task: re-read ' + $script:PromptPath + ', resume from ' + $script:ProgressPath + ' and keep going until the queue is empty.'
    if (-not (Send-DevinTextSafe $window $nudgeMessage)) {
      Write-Log 'idle nudge aborted: focus changed before paste'
      return
    }
    Register-WatchdogNudge $watchdog 'idle' $activity.newestWriteUtc $nowUtc
    Write-Log ('sent idle nudge (' + $watchdog['consecutiveNudges'] + '/6)')
  }
}

function Initialize-TaskFolder {
  $service = New-Object -ComObject 'Schedule.Service'
  $rootFolder = $null
  try {
    $service.Connect()
    $rootFolder = $service.GetFolder('\')
    try { $null = $service.GetFolder('\TivanoDevLoop') }
    catch {
      try { $null = $rootFolder.CreateFolder('TivanoDevLoop') }
      catch { $null = $service.GetFolder('\TivanoDevLoop') }
    }
  } finally {
    if ($rootFolder) { [void][Runtime.InteropServices.Marshal]::ReleaseComObject($rootFolder) }
    [void][Runtime.InteropServices.Marshal]::ReleaseComObject($service)
  }
}

function Invoke-RegisterTask {
  if (-not (Test-Path -LiteralPath $script:PromptPath -PathType Leaf)) { throw 'autopilot.md is missing next to this script.' }
  if (-not (Test-Path -LiteralPath $script:WorkspacePath -PathType Container)) { throw '-Workspace must be an existing directory.' }
  $scriptPath = [IO.Path]::GetFullPath($PSCommandPath)
  $watchArgs = @(
    '-NoProfile', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden',
    '-File', (Quote-Argument $scriptPath),
    '-Watch',
    '-Root', (Quote-Argument $script:WorkRoot),
    '-Workspace', (Quote-Argument $script:WorkspacePath),
    '-Repo', (Quote-Argument $Repo),
    '-Label', (Quote-Argument $Label),
    '-IdleMinutes', [string]$IdleMinutes,
    '-ApprovalMinutes', [string]$ApprovalMinutes,
    '-UserIdleSeconds', [string]$UserIdleSeconds,
    '-IntervalMinutes', [string]$IntervalMinutes
  )

  Initialize-TaskFolder
  $action = New-ScheduledTaskAction -Execute $script:PowerShellExe -WorkingDirectory $script:WorkRoot -Argument ($watchArgs -join ' ')
  $principal = New-ScheduledTaskPrincipal -UserId ([Security.Principal.WindowsIdentity]::GetCurrent().Name) `
    -LogonType Interactive -RunLevel Limited
  $trigger = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) -RepetitionInterval (New-TimeSpan -Minutes $IntervalMinutes)
  $settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
    -MultipleInstances IgnoreNew -StartWhenAvailable -ExecutionTimeLimit (New-TimeSpan -Minutes 30)
  $task = New-ScheduledTask -Action $action -Principal $principal -Trigger $trigger -Settings $settings
  Register-ScheduledTask -TaskName $script:TaskName -TaskPath $script:TaskPath -InputObject $task -Force | Out-Null
  # The per-issue runner would work and merge the same issues in parallel.
  $legacy = Get-ScheduledTask -TaskPath $script:TaskPath -TaskName 'run' -ErrorAction SilentlyContinue
  if ($legacy -and $legacy.State -ne 'Disabled') {
    if ($legacy.State -eq 'Running') { Stop-ScheduledTask -TaskPath $script:TaskPath -TaskName 'run' }
    $null = Disable-ScheduledTask -TaskPath $script:TaskPath -TaskName 'run'
    Write-Host 'Disabled the per-issue runner task run (autopilot replaces it).'
  }

  $registered = Get-ScheduledTask -TaskName $script:TaskName -TaskPath $script:TaskPath
  $info = Get-ScheduledTaskInfo -TaskName $script:TaskName -TaskPath $script:TaskPath
  Write-Log ('registered scheduled task ' + $script:TaskPath + $script:TaskName + ' every ' + $IntervalMinutes + 'm')
  [Console]::Out.WriteLine('Registered ' + $script:TaskPath + $script:TaskName + ' for ' + $registered.Principal.UserId + '.')
  [Console]::Out.WriteLine('  action:    ' + $registered.Actions[0].Execute + ' ' + $registered.Actions[0].Arguments)
  [Console]::Out.WriteLine('  trigger:   every ' + $IntervalMinutes + ' minutes, first run ' + $registered.Triggers[0].StartBoundary)
  [Console]::Out.WriteLine('  principal: LogonType Interactive, RunLevel Limited (runs while signed in; needed for GUI)')
  [Console]::Out.WriteLine('  limit:     30 minutes, MultipleInstances IgnoreNew, StartWhenAvailable')
  [Console]::Out.WriteLine('  log:       ' + $script:LogPath)
  [Console]::Out.WriteLine('  state:     ' + $script:WatchdogPath)
  [Console]::Out.WriteLine('  stop:      create ' + $script:StopPath + ' to stop watchdog ticks; delete it to resume')
  [Console]::Out.WriteLine('  next run:  ' + $info.NextRunTime)
}

function Invoke-UnregisterTask {
  $task = Get-ScheduledTask -TaskName $script:TaskName -TaskPath $script:TaskPath -ErrorAction SilentlyContinue
  if (-not $task) {
    [Console]::Out.WriteLine('No scheduled task ' + $script:TaskPath + $script:TaskName + ' is registered.')
    return
  }
  Unregister-ScheduledTask -TaskName $script:TaskName -TaskPath $script:TaskPath -Confirm:$false
  Write-Log ('unregistered scheduled task ' + $script:TaskPath + $script:TaskName)
  [Console]::Out.WriteLine('Removed scheduled task ' + $script:TaskPath + $script:TaskName + '; state and logs under ' + $script:WorkRoot + ' are left in place.')
}

try {
  if ([Environment]::OSVersion.Platform -ne [PlatformID]::Win32NT) { throw 'Windows is required.' }
  $modeCount = @(@($Kickoff, $Watch, $Register, $Unregister) | Where-Object { $_ }).Count
  if ($modeCount -ne 1) { throw 'Specify exactly one mode switch: -Kickoff, -Watch, -Register, or -Unregister.' }
  if ([string]::IsNullOrWhiteSpace($Repo) -or $Repo -notmatch '^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$') { throw '-Repo must be owner/name.' }

  $script:WorkRoot = Get-AcceptancePath $Root
  Assert-OutsideGitCheckout $script:WorkRoot
  Assert-AcceptanceOutsideRepo $script:WorkRoot
  $script:StateDir = Join-Path $script:WorkRoot 'state'
  $script:LogsDir = Join-Path $script:StateDir 'logs'
  $script:AutopilotDir = Join-Path $script:WorkRoot 'autopilot'
  $script:StopPath = Join-Path $script:StateDir 'STOP'
  $script:ProgressPath = Join-Path $script:AutopilotDir 'progress.json'
  $script:WatchdogPath = Join-Path $script:AutopilotDir 'watchdog.json'
  $script:LogPath = Join-Path $script:LogsDir ('autopilot-' + [DateTime]::Now.ToString('yyyyMMdd') + '.log')

  if ($Watch -and (Test-Stop)) { exit 0 }

  [IO.Directory]::CreateDirectory($script:WorkRoot) | Out-Null
  [IO.Directory]::CreateDirectory($script:LogsDir) | Out-Null
  [IO.Directory]::CreateDirectory($script:AutopilotDir) | Out-Null

  if ($Unregister) {
    Invoke-UnregisterTask
    exit 0
  }

  $script:WorkspacePath = Get-AcceptancePath $Workspace

  $redact = @($script:WorkRoot, $script:WorkspacePath, $env:USERPROFILE, $script:AcceptanceRepo)
  $redactAll = @()
  foreach ($item in $redact) {
    if ([string]::IsNullOrWhiteSpace($item) -or $item.Length -lt 4) { continue }
    $redactAll += $item
    $redactAll += $item.Replace('\', '/')
  }
  if ($env:COMPUTERNAME -and $env:COMPUTERNAME.Length -ge 6) { $redactAll += $env:COMPUTERNAME }
  $script:Redactions = @($redactAll | Sort-Object -Unique | Sort-Object { $_.Length } -Descending)

  if ($Register) {
    Invoke-RegisterTask
    exit 0
  }
  if ($Kickoff) {
    $outcome = Invoke-Kickoff -WaitForIdle $true
    if ($outcome -eq 'ok' -or $outcome -eq 'deferred') { exit 0 }
    exit 1
  }
  if ($Watch) {
    Invoke-WatchTick
    exit 0
  }
} catch {
  Write-Log ('autopilot error: ' + $_.Exception.Message)
  [Console]::Error.WriteLine('Start-DevinAutopilot failed: ' + $_.Exception.Message)
  exit 1
}
