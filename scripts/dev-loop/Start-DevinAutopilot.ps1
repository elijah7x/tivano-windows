# Tivano Windows - derived from Tivano (AGPL-3.0), modified 2026-11-22.
# Droppy Code by Jordy Spruit (Droppy), https://getdroppycode.app
# Usage: .\Start-DevinAutopilot.ps1 (-Kickoff | -Watch | -Register | -Unregister) [-Root <state root>] [-Workspace <repo checkout>] [-Repo <owner/name>] [-Label <label>] [-IdleMinutes <min>] [-ApprovalMinutes <min>] [-UserIdleSeconds <sec>] [-IntervalMinutes <min>] [-SyncSource <audit tool clone>] [-SyncTarget <pr-bot scripts dir>]
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
  [ValidateRange(1, 1440)][int]$IntervalMinutes = 15,
  [string]$SyncSource = 'C:\tivano\audit\tool',
  [string]$SyncTarget = 'C:\tivano\pr-bot\tool\scripts'
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
$script:GitPath = $null
$script:RobocopyPath = $null
$script:DevinPath = $null
$script:Redactions = @()
$script:GuiTypesLoaded = $false
$script:AutoMergeDailyCap = 20
$script:AttributionLinePattern = '(?i)co-authored-by|generated (with|by) \[?devin|devin\.ai'

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

function Invoke-Git {
  param([string]$Arguments)
  $out = Join-Path $script:AutopilotDir '.git.out.tmp'
  $err = Join-Path $script:AutopilotDir '.git.err.tmp'
  for ($try = 1; ; $try++) {
    $code = Invoke-Tool $script:GitPath $Arguments $out $err $script:WorkRoot
    $result = [pscustomobject]@{ exitCode = $code; text = (Read-Text $out); error = (Read-Text $err) }
    $combined = [string]$result.error + "`n" + [string]$result.text
    if ($code -eq 0 -or $try -ge 4 -or -not (Test-NetworkFailure $combined)) { return $result }
    Write-Log ('git network failure, retry ' + $try + '/3: ' + (ConvertTo-SingleLine $combined 160))
    Start-Sleep -Seconds (20 * $try)
  }
}

function Invoke-SelfSync {
  param($State)
  if ([string]::IsNullOrWhiteSpace($SyncSource) -or [string]::IsNullOrWhiteSpace($SyncTarget)) { return }
  if (-not (Test-Path -LiteralPath $SyncSource -PathType Container)) {
    Write-Log ('self-sync skipped: source clone missing at ' + $SyncSource)
    return
  }
  if (-not $script:GitPath) {
    $git = Get-Command -Name 'git' -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
    if (-not $git) {
      Write-Log 'self-sync skipped: git was not found on PATH'
      return
    }
    $script:GitPath = $git.Source
  }
  if (-not $script:RobocopyPath) {
    $rc = Join-Path ([Environment]::GetFolderPath('System')) 'robocopy.exe'
    if (-not (Test-Path -LiteralPath $rc -PathType Leaf)) {
      $rcCmd = Get-Command -Name 'robocopy' -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
      if ($rcCmd) { $rc = $rcCmd.Source } else { $rc = $null }
    }
    if (-not $rc) {
      Write-Log 'self-sync skipped: robocopy was not found'
      return
    }
    $script:RobocopyPath = $rc
  }

  $pull = Invoke-Git ('-C ' + (Quote-Argument $SyncSource) + ' pull --ff-only origin main')
  if ($pull.exitCode -ne 0) {
    Write-Log ('self-sync: git pull failed (exit ' + $pull.exitCode + '): ' + (ConvertTo-SingleLine (Get-ErrorSummary $pull) 200))
    return
  }

  $rev = Invoke-Git ('-C ' + (Quote-Argument $SyncSource) + ' rev-parse HEAD')
  if ($rev.exitCode -ne 0 -or [string]::IsNullOrWhiteSpace([string]$rev.text)) {
    Write-Log ('self-sync: git rev-parse HEAD failed: ' + (ConvertTo-SingleLine (Get-ErrorSummary $rev) 200))
    return
  }
  $sha = ([string]$rev.text).Trim()
  $folders = @('dev-loop', 'pr-review')
  $allTargetsExist = $true
  foreach ($folder in $folders) {
    $dstCheck = Join-Path $SyncTarget $folder
    if (-not (Test-Path -LiteralPath $dstCheck -PathType Container)) {
      $allTargetsExist = $false
      break
    }
  }
  if ($sha -eq [string]$State['lastSyncedSha'] -and $allTargetsExist) {
    Write-Log ('self-sync: SHA ' + $sha + ' unchanged; skipping mirror')
    return
  }

  $rcOut = Join-Path $script:AutopilotDir '.robocopy.out.tmp'
  $rcErr = Join-Path $script:AutopilotDir '.robocopy.err.tmp'
  $mirrorOk = $true
  foreach ($folder in $folders) {
    $srcDir = Join-Path (Join-Path $SyncSource 'scripts') $folder
    $dstDir = Join-Path $SyncTarget $folder
    if (-not (Test-Path -LiteralPath $srcDir -PathType Container)) {
      Write-Log ('self-sync: source folder missing: ' + $srcDir)
      $mirrorOk = $false
      break
    }
    [IO.Directory]::CreateDirectory($dstDir) | Out-Null
    $rcArgs = (Quote-Argument $srcDir) + ' ' + (Quote-Argument $dstDir) + ' /MIR /R:2 /W:3 /NFL /NDL /NJH /NJS /NP'
    $rcCode = Invoke-Tool $script:RobocopyPath $rcArgs $rcOut $rcErr $script:WorkRoot
    if ($rcCode -lt 0 -or $rcCode -ge 8) {
      $rcMsg = ConvertTo-SingleLine ([string](Read-Text $rcErr) + ' ' + [string](Read-Text $rcOut)) 200
      Write-Log ('self-sync: robocopy failed for scripts\' + $folder + ' (exit ' + $rcCode + '): ' + $rcMsg)
      $mirrorOk = $false
      break
    }
  }

  if ($mirrorOk) {
    $State['lastSyncedSha'] = $sha
    Save-WatchdogState $State
    Write-Log ('self-sync: synced SHA ' + $sha + ' (mirrored scripts\dev-loop and scripts\pr-review)')
  }
}

function Initialize-GuiTypes {
  if ($script:GuiTypesLoaded) { return }
  Add-Type -AssemblyName System.Windows.Forms
  Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text;
public static class DevLoopWindows {
  public sealed class WindowInfo {
    public IntPtr Handle { get; set; }
    public string Title { get; set; }
    public int Rank { get; set; }
  }
  public sealed class ForegroundInfo {
    public IntPtr Handle { get; set; }
    public string ClassName { get; set; }
    public string ProcessName { get; set; }
    public bool HasShellFlyoutOpen { get; set; }
  }
  delegate bool EnumProc(IntPtr h, IntPtr p);
  [StructLayout(LayoutKind.Sequential)]
  struct LASTINPUTINFO {
    public uint cbSize;
    public uint dwTime;
  }
  const uint GW_OWNER = 4;
  const int DWMWA_CLOAKED = 14;
  public const uint WM_CLOSE = 0x0010;
  static readonly IntPtr HWND_TOPMOST = new IntPtr(-1);
  static readonly IntPtr HWND_NOTOPMOST = new IntPtr(-2);
  const uint SWP_NOSIZE = 0x0001;
  const uint SWP_NOMOVE = 0x0002;
  const uint SWP_SHOWWINDOW = 0x0040;
  [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc cb, IntPtr p);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetClassName(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] static extern IntPtr GetWindow(IntPtr h, uint cmd);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] static extern bool GetLastInputInfo(ref LASTINPUTINFO plii);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int c);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll")] static extern bool SetWindowPos(IntPtr h, IntPtr insertAfter, int x, int y, int cx, int cy, uint flags);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern void keybd_event(byte k, byte s, uint f, UIntPtr e);
  [DllImport("user32.dll")] public static extern bool PostMessage(IntPtr h, uint msg, IntPtr wParam, IntPtr lParam);
  [DllImport("dwmapi.dll")] static extern int DwmGetWindowAttribute(IntPtr h, int attr, out int value, int size);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern void mouse_event(uint f, uint dx, uint dy, uint d, UIntPtr e);
  [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X, Y; }
  [DllImport("user32.dll")] static extern IntPtr WindowFromPoint(POINT p);
  [DllImport("user32.dll")] static extern IntPtr GetAncestor(IntPtr h, uint flags);
  // True when the top-level window under screen point (x, y) is h, so a click there lands on h.
  [DllImport("user32.dll")] static extern bool EnumChildWindows(IntPtr parent, EnumProc cb, IntPtr p);
  [DllImport("user32.dll")] static extern IntPtr SendMessage(IntPtr h, uint msg, IntPtr wParam, IntPtr lParam);
  // Answers "Don't Save" on the native save prompt (#32770) owned by window h; true when a button was clicked.
  public static bool DismissSavePrompt(IntPtr h) {
    IntPtr dialog = IntPtr.Zero;
    EnumWindows((w, p) => {
      if (IsWindowVisible(w) && GetWindow(w, GW_OWNER) == h && GetWindowClass(w) == "#32770") { dialog = w; return false; }
      return true;
    }, IntPtr.Zero);
    if (dialog == IntPtr.Zero) return false;
    IntPtr button = IntPtr.Zero;
    EnumChildWindows(dialog, (c, p) => {
      string t = GetWindowTitle(c).Replace("&", "");
      if (GetWindowClass(c) == "Button" && (t == "Don't Save" || t == "Don\u2019t Save" || t == "\u4e0d\u4fdd\u5b58")) { button = c; return false; }
      return true;
    }, IntPtr.Zero);
    if (button == IntPtr.Zero) return false;
    SendMessage(button, 0x00F5, IntPtr.Zero, IntPtr.Zero);
    return true;
  }
  public static bool IsPointOnWindow(IntPtr h, int x, int y) {
    var pt = new POINT { X = x, Y = y };
    IntPtr hit = WindowFromPoint(pt);
    if (hit == IntPtr.Zero) return false;
    return GetAncestor(hit, 2) == h;
  }
  // Raises or unpins a window in the topmost Z-order band without taking foreground rights.
  public static bool SetTopmost(IntPtr h, bool on) {
    if (h == IntPtr.Zero) return false;
    return SetWindowPos(h, on ? HWND_TOPMOST : HWND_NOTOPMOST, 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_SHOWWINDOW);
  }
  static string GetWindowTitle(IntPtr h) {
    var sb = new StringBuilder(1024);
    int len = GetWindowText(h, sb, sb.Capacity);
    return len > 0 ? sb.ToString() : "";
  }
  static string GetWindowClass(IntPtr h) {
    var sb = new StringBuilder(256);
    int len = GetClassName(h, sb, sb.Capacity);
    return len > 0 ? sb.ToString() : "";
  }
  static string GetProcessName(IntPtr h) {
    uint pid = 0;
    GetWindowThreadProcessId(h, out pid);
    if (pid == 0) return "";
    try {
      using (var proc = Process.GetProcessById((int)pid)) {
        return proc.ProcessName ?? "";
      }
    } catch {
      return "";
    }
  }
  static bool IsWindowCloaked(IntPtr h) {
    try {
      int cloaked = 0;
      return DwmGetWindowAttribute(h, DWMWA_CLOAKED, out cloaked, sizeof(int)) == 0 && cloaked != 0;
    } catch {
      return false;
    }
  }
  static bool MatchesBare(string title, string bare) {
    string tail = " " + bare;
    return title.Equals(bare, StringComparison.OrdinalIgnoreCase) ||
      title.EndsWith(tail, StringComparison.OrdinalIgnoreCase) ||
      title.StartsWith(bare + " - ", StringComparison.OrdinalIgnoreCase) ||
      title.IndexOf(tail + " - ", StringComparison.OrdinalIgnoreCase) >= 0;
  }
  static int GetWindowRank(string title, string folder) {
    if (string.IsNullOrEmpty(folder) || string.IsNullOrEmpty(title)) return 0;
    if (MatchesBare(title, folder + " (Workspace) - Devin")) return 2;
    if (MatchesBare(title, folder + " - Devin")) return 1;
    return 0;
  }
  static bool HasVisibleShellFlyout() {
    bool found = false;
    EnumWindows((h, p) => {
      if (!IsWindowVisible(h) || IsWindowCloaked(h)) return true;
      RECT r;
      if (!GetWindowRect(h, out r) || (r.Right - r.Left) <= 0 || (r.Bottom - r.Top) <= 0) return true;
      string cls = GetWindowClass(h);
      string proc = GetProcessName(h);
      if (string.Equals(cls, "ControlCenterWindow", StringComparison.OrdinalIgnoreCase) ||
          string.Equals(cls, "NotifyIconOverflowWindow", StringComparison.OrdinalIgnoreCase) ||
          string.Equals(cls, "TopLevelWindowForOverflowXamlIsland", StringComparison.OrdinalIgnoreCase) ||
          (string.Equals(cls, "Xaml_WindowedPopupClass", StringComparison.OrdinalIgnoreCase) && (r.Right - r.Left) >= 100 && (r.Bottom - r.Top) >= 100) ||
          string.Equals(proc, "ShellHost", StringComparison.OrdinalIgnoreCase) ||
          string.Equals(proc, "ShellExperienceHost", StringComparison.OrdinalIgnoreCase) ||
          string.Equals(proc, "StartMenuExperienceHost", StringComparison.OrdinalIgnoreCase) ||
          string.Equals(proc, "SearchHost", StringComparison.OrdinalIgnoreCase)) {
        found = true;
        return false;
      }
      return true;
    }, IntPtr.Zero);
    return found;
  }
  public static ForegroundInfo GetForegroundInfo() {
    IntPtr h = GetForegroundWindow();
    var info = new ForegroundInfo { Handle = h, ClassName = "", ProcessName = "", HasShellFlyoutOpen = false };
    if (h == IntPtr.Zero) return info;
    info.ClassName = GetWindowClass(h);
    info.ProcessName = GetProcessName(h);
    if (string.Equals(info.ClassName, "Shell_TrayWnd", StringComparison.OrdinalIgnoreCase)) {
      info.HasShellFlyoutOpen = HasVisibleShellFlyout();
    }
    return info;
  }
  public static bool CloseWindow(IntPtr h) {
    if (h == IntPtr.Zero) return false;
    return PostMessage(h, WM_CLOSE, IntPtr.Zero, IntPtr.Zero);
  }
  // Devin Desktop titles a window "<folder> - Devin", "<folder> (Workspace) - Devin", or
  // "<session title> <folder> ... - Devin", plus " - <open editor>" when a file is open.
  public static WindowInfo[] FindAll(string folder) {
    var list = new List<WindowInfo>();
    var order = new Dictionary<IntPtr, int>();
    int idx = 0;
    EnumWindows((h, p) => {
      if (!IsWindowVisible(h)) return true;
      if (GetWindow(h, GW_OWNER) != IntPtr.Zero) return true;
      string title = GetWindowTitle(h);
      if (string.IsNullOrWhiteSpace(title)) return true;
      string proc = GetProcessName(h);
      if (!string.Equals(proc, "Devin", StringComparison.OrdinalIgnoreCase)) return true;
      var item = new WindowInfo {
        Handle = h,
        Title = title,
        Rank = GetWindowRank(title, folder)
      };
      order[h] = idx++;
      list.Add(item);
      return true;
    }, IntPtr.Zero);
    list.Sort((a, b) => {
      int cmp = b.Rank.CompareTo(a.Rank);
      if (cmp != 0) return cmp;
      return order[a.Handle].CompareTo(order[b.Handle]);
    });
    return list.ToArray();
  }
  public static IntPtr Find(string folder) {
    WindowInfo[] all = FindAll(folder);
    if (all.Length > 0 && all[0].Rank > 0) return all[0].Handle;
    return IntPtr.Zero;
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

function Test-ShellFlyoutForeground {
  param($Foreground)
  if ($null -eq $Foreground) { return $false }
  $cls = [string]$Foreground.ClassName
  $proc = [string]$Foreground.ProcessName
  if ($cls -ieq 'ControlCenterWindow') { return $true }
  if (@('ShellHost', 'ShellExperienceHost', 'StartMenuExperienceHost', 'SearchHost') -contains $proc) { return $true }
  if ($cls -ieq 'Shell_TrayWnd' -and [bool]$Foreground.HasShellFlyoutOpen) { return $true }
  return $false
}

function Close-ExtraDevinWindows {
  param([string]$Folder)
  $all = @([DevLoopWindows]::FindAll($Folder))
  if ($all.Count -le 1) { return 0 }
  $preferred = [IntPtr]::Zero
  if ($all[0].Rank -gt 0) {
    $preferred = $all[0].Handle
  }
  # Close only what is provably ours: duplicate windows for this workspace, and empty
  # folderless chats ("Devin - <untitled or /bypass>") left by failed kickoffs. Sessions in other
  # folders are kept, and nothing is closed while no window matches this workspace.
  if ($preferred -eq [IntPtr]::Zero) {
    # Still answer save prompts left on folderless windows; their buffers only hold kickoff text.
    foreach ($win in $all) {
      if ([string]$win.Title -match '^Devin( - |$)' -and [DevLoopWindows]::DismissSavePrompt($win.Handle)) {
        Write-Log 'discarded a save prompt on a folderless Devin window'
      }
    }
    return 0
  }
  $closed = 0
  foreach ($win in $all) {
    if ($win.Handle -eq $preferred) { continue }
    if (-not ($win.Rank -gt 0 -or [string]$win.Title -match '^Devin( - |$)')) { continue }
    # A dirty editor (title carries the U+25CF marker) answers WM_CLOSE with a save prompt. In a
    # folderless window the buffer only ever holds text a failed kickoff pasted (such as "/bypass"),
    # so the prompt is answered "Don't Save"; a dirty duplicate of the workspace window is left alone.
    $isDirty = (([string]$win.Title).IndexOf([char]0x25CF) -ge 0)
    $isFolderless = ([string]$win.Title -match '^Devin( - |$)')
    if ($isDirty -and -not $isFolderless) { continue }
    $null = [DevLoopWindows]::DismissSavePrompt($win.Handle)
    if ([DevLoopWindows]::CloseWindow($win.Handle)) {
      if ($isDirty) {
        Start-Sleep -Milliseconds 1500
        if ([DevLoopWindows]::DismissSavePrompt($win.Handle)) {
          Write-Log 'discarded an unsaved folderless Devin buffer left by an earlier kickoff'
        }
      }
      $closed++
    }
  }
  if ($closed -gt 0) {
    if ($preferred -ne [IntPtr]::Zero) {
      Write-Log ('closed ' + $closed + ' extra Devin Desktop window(s) (kept "' + (ConvertTo-SingleLine $all[0].Title 120) + '")')
    } else {
      Write-Log ('closed ' + $closed + ' extra non-matching Devin Desktop window(s) (none matched "' + $Folder + '")')
    }
    Start-Sleep -Milliseconds 500
  }
  return $closed
}

function Set-DevinForeground {
  param([IntPtr]$Window)
  if ($Window -eq [IntPtr]::Zero) { return $false }
  $fg = [DevLoopWindows]::GetForegroundInfo()
  if (Test-ShellFlyoutForeground $fg) {
    [DevLoopWindows]::keybd_event(0x1B, 0, 0, [UIntPtr]::Zero)
    [DevLoopWindows]::keybd_event(0x1B, 0, 2, [UIntPtr]::Zero)
    Start-Sleep -Milliseconds 500
    Write-Log ('dismissed shell flyout (class=' + $fg.ClassName + ', process=' + $fg.ProcessName + ')')
  }
  for ($attempt = 0; $attempt -lt 2; $attempt++) {
    [DevLoopWindows]::ShowWindow($Window, 9) | Out-Null
    # A tap of Alt lets a background process take the foreground.
    [DevLoopWindows]::keybd_event(0x12, 0, 0, [UIntPtr]::Zero); [DevLoopWindows]::keybd_event(0x12, 0, 2, [UIntPtr]::Zero)
    [DevLoopWindows]::SetForegroundWindow($Window) | Out-Null
    Start-Sleep -Milliseconds 800
    if (Test-DevinForeground $Window) { return $true }
    if ($attempt -eq 1) {
      # On Nyx every SetForegroundWindow variant (Alt tap, AttachThreadInput, SwitchToThisWindow,
      # a zero foreground-lock timeout) is refused for the scheduled-task process, but a real click
      # activates the window. Restore if minimized, maximize, temporarily lift topmost above
      # covering non-topmost windows, and click the chat input point only when that point is on
      # the Devin window itself.
      if ([DevLoopWindows]::IsIconic($Window)) {
        [DevLoopWindows]::ShowWindow($Window, 9) | Out-Null
        Start-Sleep -Milliseconds 300
      }
      [DevLoopWindows]::ShowWindow($Window, 3) | Out-Null
      Start-Sleep -Milliseconds 800
      try {
        [DevLoopWindows]::SetTopmost($Window, $true) | Out-Null
        Start-Sleep -Milliseconds 300
        $rect = New-Object DevLoopWindows+RECT
        if ([DevLoopWindows]::GetWindowRect($Window, [ref]$rect)) {
          $width = $rect.Right - $rect.Left
          $height = $rect.Bottom - $rect.Top
          $x = [int]($rect.Left + $width * 0.60)
          $y = [int]($rect.Bottom - $height * 0.11)
          if ([DevLoopWindows]::IsPointOnWindow($Window, $x, $y)) {
            [DevLoopWindows]::SetCursorPos($x, $y) | Out-Null
            Start-Sleep -Milliseconds 200
            [DevLoopWindows]::mouse_event(0x0002, 0, 0, 0, [UIntPtr]::Zero)
            [DevLoopWindows]::mouse_event(0x0004, 0, 0, 0, [UIntPtr]::Zero)
            Start-Sleep -Milliseconds 800
            if (Test-DevinForeground $Window) {
              Write-Log 'focused Devin window by clicking its chat input (SetForegroundWindow refused)'
              return $true
            }
          } else {
            Write-Log 'focus click skipped: another window covers the Devin chat input'
          }
        }
      } finally {
        [DevLoopWindows]::SetTopmost($Window, $false) | Out-Null
      }
    }
    if ($attempt -eq 0) {
      $fgRetry = [DevLoopWindows]::GetForegroundInfo()
      if (Test-ShellFlyoutForeground $fgRetry) {
        [DevLoopWindows]::keybd_event(0x1B, 0, 0, [UIntPtr]::Zero)
        [DevLoopWindows]::keybd_event(0x1B, 0, 2, [UIntPtr]::Zero)
        Start-Sleep -Milliseconds 500
        Write-Log ('dismissed shell flyout on focus retry (class=' + $fgRetry.ClassName + ', process=' + $fgRetry.ProcessName + ')')
      }
    }
  }
  return $false
}

# Keyboard shortcuts toggle the chat panel or land in an open editor depending on what had focus, so the
# chat input is clicked instead: maximized, it is the box at the bottom of the right-hand Devin panel.
# No Ctrl+A/Delete afterwards: if the click ever lands in an editor, a paste is recoverable, a wipe is not.
function Focus-DevinChatInput {
  param([IntPtr]$Window)
  if (-not (Set-DevinForeground $Window)) { return $false }
  if ([DevLoopWindows]::IsIconic($Window)) {
    [DevLoopWindows]::ShowWindow($Window, 9) | Out-Null
    Start-Sleep -Milliseconds 300
  }
  [DevLoopWindows]::ShowWindow($Window, 3) | Out-Null
  Start-Sleep -Milliseconds 800
  if (-not (Test-DevinForeground $Window)) { return $false }
  try {
    [DevLoopWindows]::SetTopmost($Window, $true) | Out-Null
    Start-Sleep -Milliseconds 300
    $rect = New-Object DevLoopWindows+RECT
    if (-not [DevLoopWindows]::GetWindowRect($Window, [ref]$rect)) { return $false }
    $width = $rect.Right - $rect.Left
    $height = $rect.Bottom - $rect.Top
    # Lands in the chat input both in the IDE view's side chat and in the
    # Agents view with its right-hand panel hidden (maximized window).
    # The input box is centred in the chat column; a "N files changed" strip above it pushes it down,
    # so aim low (11% from the bottom) and at 60% of the width, inside the box with or without the strip.
    $x = [int]($rect.Left + $width * 0.60)
    $y = [int]($rect.Bottom - $height * 0.11)
    if (-not [DevLoopWindows]::IsPointOnWindow($Window, $x, $y)) {
      Write-Log 'chat input click skipped: another window covers the Devin chat input'
      return $false
    }
    [DevLoopWindows]::SetCursorPos($x, $y) | Out-Null
    Start-Sleep -Milliseconds 200
    [DevLoopWindows]::mouse_event(0x0002, 0, 0, 0, [UIntPtr]::Zero)
    [DevLoopWindows]::mouse_event(0x0004, 0, 0, 0, [UIntPtr]::Zero)
    Start-Sleep -Milliseconds 600
    return (Test-DevinForeground $Window)
  } finally {
    [DevLoopWindows]::SetTopmost($Window, $false) | Out-Null
  }
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
  return $lines.ToArray()
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
      # Devin Desktop logs housekeeping every minute with no agent turn running (session database
      # jobs, session/list, remote config, seat status, analytics), so only model calls, tool runs and
      # trajectory/message writes count as agent work.
      $agentWork = ($line -match 'GetChatMessage|RecordTrajectorySegmentEvents|^\S+Z\s+\w+\s+toolbox|message_forest|store_message_node')
      if ($agentWork -and ($null -eq $newestWriteUtc -or $parsed -gt $newestWriteUtc)) { $newestWriteUtc = $parsed }
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
    lastSyncedSha = ''
    lastKickoffUtc = ''
    lastKickoffOutcome = ''
    lastKickoffAttemptUtc = ''
    kickoffFailures = 0
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
  foreach ($key in @('lastSyncedSha', 'lastKickoffUtc', 'lastKickoffOutcome', 'lastKickoffAttemptUtc', 'firstSeenUtc', 'lastSeenLogWriteUtc', 'lastNudgeUtc', 'lastNudgeReason', 'lastNudgeLogWriteUtc')) {
    $val = Get-JsonProp $data $key
    if ($null -ne $val) { $state[$key] = [string]$val }
  }
  foreach ($key in @('trackingIssue', 'kickoffFailures', 'consecutiveNudges', 'totalNudges')) {
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
  for ($attempt = 1; $attempt -le 8; $attempt++) {
    try {
      if (Test-Path -LiteralPath $script:WatchdogPath -PathType Leaf) {
        # PowerShell turns $null into an empty string for a string parameter; File.Replace needs a real null.
        [IO.File]::Replace($temporary, $script:WatchdogPath, [NullString]::Value)
      } else {
        [IO.File]::Move($temporary, $script:WatchdogPath)
      }
      return
    } catch {
      if ($attempt -lt 8) {
        Start-Sleep -Milliseconds (250 * $attempt)
      }
    }
  }
  try {
    [IO.File]::Copy($temporary, $script:WatchdogPath, $true)
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
    if ($names -notcontains 'parked') { return $true }
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
  $message = 'Autopilot chat looks unresponsive after 6 consecutive nudges with no new agent log activity; restarting Devin Desktop automatically.'
  $clean = ConvertTo-SingleLine (Protect-PublicText $message) 500
  $bodyPath = Join-Path $script:AutopilotDir ('tracking-stuck-' + [Guid]::NewGuid().ToString('N').Substring(0, 8) + '.md')
  try {
    Write-Text $bodyPath ($stamp + ' ' + $clean + "`n")
    $result = Invoke-Gh ('issue comment ' + $issueNo + ' -R ' + $Repo + ' --body-file ' + (Quote-Argument $bodyPath))
    if ($result.exitCode -ne 0) {
      Write-Log ('could not comment on tracking issue #' + $issueNo + ': ' + (Get-ErrorSummary $result))
      return $false
    }
    Write-Log ('posted restart notification to tracking issue #' + $issueNo)
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
    $State['nudges'] = $history.GetRange($history.Count - 50, 50).ToArray()
  } else {
    $State['nudges'] = $history.ToArray()
  }
  Save-WatchdogState $State
}

function Resolve-DevinLauncher {
  if ($script:DevinPath) { return $script:DevinPath }
  $devin = Get-Command -Name 'devin' -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
  if (-not $devin) { throw 'Devin CLI was not found on PATH; install it and sign in as the operating account.' }
  $script:DevinPath = $devin.Source
  return $script:DevinPath
}

function Set-KickoffOutcome {
  param([string]$Outcome)
  $nowUtc = [DateTime]::UtcNow
  $watchdog = Read-WatchdogState
  $watchdog['lastKickoffAttemptUtc'] = $nowUtc.ToString('o')
  $watchdog['lastKickoffOutcome'] = $Outcome
  if ($Outcome -eq 'ok') {
    $watchdog['lastKickoffUtc'] = $nowUtc.ToString('o')
    $watchdog['kickoffFailures'] = 0
    $watchdog['consecutiveNudges'] = 0
    $watchdog['stuckNotified'] = $false
  } elseif ($Outcome -eq 'failed') {
    $watchdog['kickoffFailures'] = [int]$watchdog['kickoffFailures'] + 1
  }
  Save-WatchdogState $watchdog
}

function Stop-DevinDesktop {
  # Stop only Devin Desktop's own process trees; the Devin CLI (bin\devin.exe) used by the
  # PR reviewer and the audit arbiter must keep running.
  $procs = @(Get-CimInstance Win32_Process -Filter "Name='Devin.exe'" -ErrorAction SilentlyContinue | Where-Object {
    $_.ExecutablePath -and
    $_.ExecutablePath -notmatch '\\bin\\devin\.exe$' -and
    [string]$_.CommandLine -notmatch '--type=' -and
    [string]$_.CommandLine -notmatch '--require='
  })
  foreach ($desk in $procs) {
    $null = & taskkill.exe /T /F /PID ([int]$desk.ProcessId) 2>&1
  }
  if ($procs.Count -gt 0) {
    Write-Log ('stopped ' + $procs.Count + ' Devin Desktop process tree(s)')
    Start-Sleep -Seconds 3
  }
  return $procs.Count
}

function Invoke-Kickoff {
  param([bool]$WaitForIdle)
  if (-not (Test-Path -LiteralPath $script:PromptPath -PathType Leaf)) { throw 'autopilot.md is missing next to this script.' }
  if (-not (Test-Path -LiteralPath $script:WorkspacePath -PathType Container)) { throw '-Workspace does not exist.' }
  if (Test-Stop) { Write-Log 'STOP file present; kickoff exiting'; return 'deferred' }
  Initialize-GuiTypes

  $folder = Split-Path -Leaf $script:WorkspacePath
  if (-not $WaitForIdle) {
    $null = Close-ExtraDevinWindows $folder
  }
  $window = [DevLoopWindows]::Find($folder)
  $openedNow = $false
  if ($window -eq [IntPtr]::Zero -and (Get-Process -Name 'Devin' -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne [IntPtr]::Zero })) {
    # Another Devin window is open (a renamed title the matcher missed, or a
    # session in another folder). A second window would steal the running
    # session's lock, so skip launching another this tick.
    Write-Log ('gui: a Devin Desktop window is open but none matches ' + $folder + '; not launching another')
    Set-KickoffOutcome 'failed'
    return 'failed'
  }
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
      Set-KickoffOutcome 'failed'
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
  if ($WaitForIdle -or $openedNow) { $null = Close-ExtraDevinWindows $folder }
  $window = [DevLoopWindows]::Find($folder)
  if ($window -eq [IntPtr]::Zero) {
    Write-Log ('gui: Devin Desktop window for ' + $folder + ' disappeared before send')
    Set-KickoffOutcome 'failed'
    return 'failed'
  }

  $message = 'First re-read ' + $script:PromptPath + ' and carry it out exactly as written. Then check open nyx/ PRs on GitHub and ' + $script:ProgressPath + '. Never merge PRs yourself: the watchdog merges any PR whose gate passed and nyx/audit is success on the exact head. Any open nyx/ PR whose current head has no passing gate needs Invoke-AutopilotGate.ps1 run on that head before any new issue starts. Work through the whole queue, parked revisits, hands-on milestone, and 30-minute polling loop without asking questions or waiting for a person. Re-read ' + $script:PromptPath + ' after every issue. Use these values wherever the file names its defaults: repository ' + $Repo + ', label ' + $Label + ', root folder ' + $script:WorkRoot + ' (progress.json and parked.json in its autopilot subfolder, STOP in its state subfolder). With 3 or more open non-parked nyx/ PRs, start no new issue: fix, gate and finish the open ones first.'
  $soloPlan = Join-Path $PSScriptRoot 'solo-v3.md'
  $soloStatePath = Join-Path $script:AutopilotDir 'solo-v3.json'
  $soloState = Read-JsonFile $soloStatePath
  if ($soloState -and (Test-Path -LiteralPath $soloPlan) -and [string](Get-JsonProp $soloState 'phase') -ne 'done') {
    $message = 'Continue the mission: first re-read ' + $soloPlan + ' and ' + $script:PromptPath + ', then check open nyx/ PRs on GitHub, ' + $script:ProgressPath + ', and ' + $soloStatePath + '. Never merge PRs yourself: the watchdog merges any PR whose gate passed and nyx/audit is success on the exact head. Any open nyx/ PR whose current head has no passing gate needs Invoke-AutopilotGate.ps1 run on that head before any new issue starts. Keep working through every phase, milestone, and polling cycle without waiting for a person. Do not end your turn with a checkpoint while work remains. With 3 or more open non-parked nyx/ PRs, start no new issue: fix, gate and finish the open ones first.'
  }
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
    Set-KickoffOutcome 'failed'
    return 'failed'
  }

  Set-KickoffOutcome 'ok'
  Write-Log ('kickoff sent autopilot prompt to Devin Desktop window "' + $folder + '"')
  return 'ok'
}

function Get-BusyAutopilotProcesses {
  $workDir = Join-Path $script:WorkRoot 'work'
  return @(Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | Where-Object {
    $_.CommandLine -and (
      $_.CommandLine -like ('*' + $workDir + '*') -or
      $_.CommandLine -match 'Invoke-AutopilotGate|Invoke-PrReview|Invoke-GlmReview|package-windows|packaged-smoke'
    )
  })
}

function Quote-Win32Argument {
  param([AllowEmptyString()][string]$Value)
  if ($null -eq $Value) { return '""' }
  $escaped = [regex]::Replace($Value, '(\\*)"', '$1$1\"')
  $escaped = [regex]::Replace($escaped, '(\\+)$', '$1$1')
  return '"' + $escaped + '"'
}

function Remove-AttributionLines {
  param([AllowEmptyString()][string]$Text)
  if ([string]::IsNullOrEmpty($Text)) { return '' }
  $kept = New-Object Collections.Generic.List[string]
  foreach ($line in ($Text -split "`r?`n")) {
    if ($line -match $script:AttributionLinePattern) { continue }
    $null = $kept.Add($line)
  }
  return (($kept.ToArray() -join "`n").TrimEnd())
}

function Get-LatestPrGateSummary {
  param([int]$PrNumber)
  $gateRoot = Join-Path $script:AutopilotDir 'gate'
  if (-not (Test-Path -LiteralPath $gateRoot -PathType Container)) { return $null }
  $prefix = 'pr-' + $PrNumber + '-'
  $dirs = @(Get-ChildItem -LiteralPath $gateRoot -Directory -ErrorAction SilentlyContinue |
    Where-Object { $_.Name.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase) })
  if ($dirs.Count -eq 0) { return $null }
  # A newer gate run that has not written summary.json yet is still in progress; never fall back
  # to an older passing summary while it runs.
  $newestDir = @($dirs | Sort-Object @{ Expression = { $_.CreationTimeUtc }; Descending = $true }, @{ Expression = { $_.Name }; Descending = $true })[0]
  if (-not (Test-Path -LiteralPath (Join-Path $newestDir.FullName 'summary.json') -PathType Leaf)) {
    return [pscustomobject]@{ path = ''; data = [pscustomobject]@{ verdict = 'pending'; headSha = '' } }
  }

  $summaryFiles = New-Object Collections.Generic.List[object]
  foreach ($dir in $dirs) {
    $candidate = Join-Path $dir.FullName 'summary.json'
    if (Test-Path -LiteralPath $candidate -PathType Leaf) {
      $item = Get-Item -LiteralPath $candidate -ErrorAction SilentlyContinue
      if ($null -ne $item) { $null = $summaryFiles.Add($item) }
    }
  }
  $arr = @($summaryFiles.ToArray())
  if ($arr.Count -eq 0) { return $null }

  $ordered = @($arr | Sort-Object `
    @{ Expression = { $_.LastWriteTimeUtc }; Descending = $true }, `
    @{ Expression = { $_.Directory.Name }; Descending = $true })
  $newest = $ordered[0]
  $data = Read-JsonFile $newest.FullName
  return [pscustomobject]@{
    path = $newest.FullName
    data = $data
  }
}

function Get-TodayMergedNyxPrCount {
  $today = [DateTime]::Now.ToString('yyyy-MM-dd')
  $sinceDate = [DateTime]::UtcNow.AddDays(-2).ToString('yyyy-MM-dd')
  $res = Invoke-Gh ('pr list -R ' + $Repo + ' --state merged --search ' + (Quote-Argument ('merged:>=' + $sinceDate)) + ' --limit 100 --json number,headRefName,mergedAt')
  if ($res.exitCode -ne 0) {
    Write-Log ('auto-merge: gh pr list --state merged failed: ' + (ConvertTo-SingleLine (Get-ErrorSummary $res) 200))
    return $null
  }
  if ([string]::IsNullOrWhiteSpace([string]$res.text)) { return 0 }
  $items = @()
  try {
    $parsed = $res.text | ConvertFrom-Json
    if ($null -ne $parsed) {
      $items = @($parsed | Where-Object { $null -ne $_ })
    }
  } catch {
    Write-Log ('auto-merge: could not parse merged PR list JSON: ' + (ConvertTo-SingleLine $_.Exception.Message 200))
    return $null
  }
  $count = 0
  foreach ($item in $items) {
    $headRef = [string](Get-JsonProp $item 'headRefName')
    if (-not $headRef.StartsWith('nyx/', [StringComparison]::Ordinal)) { continue }
    $mergedAt = [string](Get-JsonProp $item 'mergedAt')
    if ([string]::IsNullOrWhiteSpace($mergedAt)) { continue }
    $parsedDto = [DateTimeOffset]::MinValue
    if ([DateTimeOffset]::TryParse($mergedAt, [Globalization.CultureInfo]::InvariantCulture, [Globalization.DateTimeStyles]::AssumeUniversal, [ref]$parsedDto)) {
      if ($parsedDto.LocalDateTime.ToString('yyyy-MM-dd') -eq $today) {
        $count++
      }
    }
  }
  return $count
}

function Add-AuditLogComment {
  param([string]$Message)
  $logTitle = 'Audit log'
  $issueNo = 0
  $search = Invoke-Gh ('issue list -R ' + $Repo + ' --state open --label audit-log --limit 20 --json number,title')
  if ($search.exitCode -eq 0 -and -not [string]::IsNullOrWhiteSpace([string]$search.text)) {
    try {
      $items = @($search.text | ConvertFrom-Json | Where-Object { $null -ne $_ })
      $exact = @($items | Where-Object { ([string](Get-JsonProp $_ 'title')).Trim() -ceq $logTitle } | Sort-Object { [int](Get-JsonProp $_ 'number') })
      if ($exact.Count -gt 0) { $issueNo = [int](Get-JsonProp $exact[0] 'number') }
    } catch { }
  }
  if ($issueNo -le 0) {
    $fallback = Invoke-Gh ('issue list -R ' + $Repo + ' --state open --search ' + (Quote-Argument ($logTitle + ' in:title')) + ' --limit 20 --json number,title')
    if ($fallback.exitCode -eq 0 -and -not [string]::IsNullOrWhiteSpace([string]$fallback.text)) {
      try {
        $items = @($fallback.text | ConvertFrom-Json | Where-Object { $null -ne $_ })
        $exact = @($items | Where-Object { ([string](Get-JsonProp $_ 'title')).Trim() -ceq $logTitle } | Sort-Object { [int](Get-JsonProp $_ 'number') })
        if ($exact.Count -gt 0) { $issueNo = [int](Get-JsonProp $exact[0] 'number') }
      } catch { }
    }
  }
  if ($issueNo -le 0) {
    Write-Log 'auto-merge: could not locate open Audit log issue to record alert'
    return $false
  }
  $stamp = [DateTime]::Now.ToString('yyyy-MM-ddTHH:mm:ssK')
  $clean = ConvertTo-SingleLine (Protect-PublicText $Message) 500
  $bodyPath = Join-Path $script:AutopilotDir ('audit-log-' + [Guid]::NewGuid().ToString('N').Substring(0, 8) + '.md')
  try {
    Write-Text $bodyPath ($stamp + ' ' + $clean + "`n")
    $commentRes = Invoke-Gh ('issue comment ' + $issueNo + ' -R ' + $Repo + ' --body-file ' + (Quote-Argument $bodyPath))
    if ($commentRes.exitCode -ne 0) {
      Write-Log ('auto-merge: failed to comment on Audit log issue #' + $issueNo + ': ' + (ConvertTo-SingleLine (Get-ErrorSummary $commentRes) 200))
      return $false
    }
    Write-Log ('auto-merge: appended alert to Audit log issue #' + $issueNo)
    return $true
  } finally {
    Remove-Item -LiteralPath $bodyPath -Force -ErrorAction SilentlyContinue
  }
}

function Invoke-AutoMerge {
  param([switch]$DryRun)
  $whatIfVar = Get-Variable -Name 'WhatIfPreference' -ErrorAction SilentlyContinue
  $isDryRun = [bool]$DryRun
  if ($null -ne $whatIfVar -and [bool]$whatIfVar.Value) { $isDryRun = $true }

  if (-not $script:GhPath) {
    $ghCmd = Get-Command -Name 'gh' -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
    if (-not $ghCmd) {
      Write-Log 'auto-merge: skipped (gh was not found on PATH)'
      return
    }
    $script:GhPath = $ghCmd.Source
  }

  $listRes = Invoke-Gh ('pr list -R ' + $Repo + ' --state open --limit 100 --json number,headRefName,headRefOid,title,body,labels,author,baseRefName,isCrossRepository')
  if ($listRes.exitCode -ne 0) {
    Write-Log ('auto-merge: skipped (gh pr list failed: ' + (ConvertTo-SingleLine (Get-ErrorSummary $listRes) 200) + ')')
    return
  }
  if ([string]::IsNullOrWhiteSpace([string]$listRes.text)) { return }

  $openPrs = @()
  try {
    $parsedPrs = $listRes.text | ConvertFrom-Json
    if ($null -ne $parsedPrs) {
      $openPrs = @($parsedPrs | Where-Object { $null -ne $_ } | Sort-Object { [int](Get-JsonProp $_ 'number') })
    }
  } catch {
    Write-Log ('auto-merge: skipped (could not parse gh pr list JSON: ' + (ConvertTo-SingleLine $_.Exception.Message 200) + ')')
    return
  }

  $mergedTodayLoaded = $false
  $mergedToday = $null

  foreach ($pr in $openPrs) {
    if (Test-Stop) {
      Write-Log 'auto-merge: STOP file present; stopping'
      break
    }

    $prNum = 0
    $rawNum = Get-JsonProp $pr 'number'
    if ($null -ne $rawNum) { $prNum = [int]$rawNum }
    $headRef = [string](Get-JsonProp $pr 'headRefName')
    if ($prNum -le 0 -or -not $headRef.StartsWith('nyx/', [StringComparison]::Ordinal)) { continue }

    try {
      $labels = @(Get-LabelNames (Get-JsonProp $pr 'labels'))
      if ($labels -contains 'audit-parked') {
        Write-Log ('auto-merge PR #' + $prNum + ': skipped (labelled audit-parked)')
        continue
      }
      # Only the repository owner's own same-repo PRs into main are in scope.
      $ownerLogin = ($Repo -split '/')[0]
      $authorLogin = [string](Get-JsonProp (Get-JsonProp $pr 'author') 'login')
      $isCross = [bool](Get-JsonProp $pr 'isCrossRepository')
      $baseRef = [string](Get-JsonProp $pr 'baseRefName')
      if ($isCross -or $authorLogin -ne $ownerLogin -or $baseRef -ne 'main') {
        Write-Log ('auto-merge PR #' + $prNum + ': skipped (not an owner same-repo PR into main)')
        continue
      }

      $headSha = ([string](Get-JsonProp $pr 'headRefOid')).Trim()
      if ([string]::IsNullOrWhiteSpace($headSha)) {
        Write-Log ('auto-merge PR #' + $prNum + ': skipped (missing headRefOid)')
        continue
      }
      $sha7 = $headSha
      if ($sha7.Length -gt 7) { $sha7 = $sha7.Substring(0, 7) }

      # (a) Newest gate summary.json has verdict 'pass' and headSha equal to live headRefOid.
      $gateSummary = Get-LatestPrGateSummary -PrNumber $prNum
      if ($null -eq $gateSummary) {
        Write-Log ('auto-merge PR #' + $prNum + ' (' + $sha7 + '): skipped (no gate summary.json found)')
        continue
      }
      if ($null -eq $gateSummary.data) {
        Write-Log ('auto-merge PR #' + $prNum + ' (' + $sha7 + '): skipped (newest gate summary.json unreadable)')
        continue
      }
      $gateVerdict = ([string](Get-JsonProp $gateSummary.data 'verdict')).Trim().ToLowerInvariant()
      $gateSha = ([string](Get-JsonProp $gateSummary.data 'headSha')).Trim()
      if ($gateVerdict -ne 'pass') {
        $shownVerdict = $gateVerdict
        if (-not $shownVerdict) { $shownVerdict = 'empty' }
        Write-Log ('auto-merge PR #' + $prNum + ' (' + $sha7 + '): skipped (gate verdict is ' + $shownVerdict + ', need pass)')
        continue
      }
      if (-not $gateSha.Equals($headSha, [StringComparison]::OrdinalIgnoreCase)) {
        $gateSha7 = $gateSha
        if ($gateSha7.Length -gt 7) { $gateSha7 = $gateSha7.Substring(0, 7) }
        if (-not $gateSha7) { $gateSha7 = 'empty' }
        Write-Log ('auto-merge PR #' + $prNum + ' (' + $sha7 + '): skipped (gate headSha ' + $gateSha7 + ' does not match live head ' + $sha7 + ')')
        continue
      }

      # (c) PR body contains a closing keyword for the issue number parsed from nyx/<n>-...
      $branchMatch = [regex]::Match($headRef, '^nyx/([0-9]+)-')
      if (-not $branchMatch.Success) {
        Write-Log ('auto-merge PR #' + $prNum + ' (' + $sha7 + '): skipped (branch ' + $headRef + ' does not match nyx/<issue>-...)')
        continue
      }
      $issueNum = [int]$branchMatch.Groups[1].Value
      if ($issueNum -le 0) {
        Write-Log ('auto-merge PR #' + $prNum + ' (' + $sha7 + '): skipped (invalid issue number in branch ' + $headRef + ')')
        continue
      }
      $prBody = [string](Get-JsonProp $pr 'body')
      $closingPattern = '(?i)\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\s*:?\s*(?:' + [regex]::Escape($Repo) + ')?#' + $issueNum + '\b'
      if ([string]::IsNullOrWhiteSpace($prBody) -or ($prBody -notmatch $closingPattern)) {
        Write-Log ('auto-merge PR #' + $prNum + ' (' + $sha7 + '): skipped (PR body missing closing keyword for #' + $issueNum + ')')
        continue
      }
      # The linked issue must be in the autopilot queue (label) and not parked (label or parked.json).
      $issueRes = Invoke-Gh ('issue view ' + $issueNum + ' -R ' + $Repo + ' --json labels,state')
      if ($issueRes.exitCode -ne 0) {
        Write-Log ('auto-merge PR #' + $prNum + ' (' + $sha7 + '): skipped (gh issue view #' + $issueNum + ' failed)')
        continue
      }
      $issueLabels = @()
      try { $issueLabels = @(Get-LabelNames (Get-JsonProp ($issueRes.text | ConvertFrom-Json) 'labels')) } catch { $issueLabels = @() }
      if ($issueLabels -notcontains $Label) {
        Write-Log ('auto-merge PR #' + $prNum + ' (' + $sha7 + '): skipped (issue #' + $issueNum + ' is not labelled ' + $Label + ')')
        continue
      }
      if ($issueLabels -contains 'parked') {
        Write-Log ('auto-merge PR #' + $prNum + ' (' + $sha7 + '): skipped (issue #' + $issueNum + ' is labelled parked)')
        continue
      }
      $parkedPath = Join-Path $script:AutopilotDir 'parked.json'
      $parkedHit = $false
      if (Test-Path -LiteralPath $parkedPath -PathType Leaf) {
        $parkedData = Read-JsonFile $parkedPath
        foreach ($entry in @($parkedData | Where-Object { $null -ne $_ })) {
          $pi = 0; $pp = 0
          try { $pi = [int](Get-JsonProp $entry 'issue') } catch { }
          try { $pp = [int](Get-JsonProp $entry 'pr') } catch { }
          if (($pi -gt 0 -and $pi -eq $issueNum) -or ($pp -gt 0 -and $pp -eq $prNum)) { $parkedHit = $true }
        }
      }
      if ($parkedHit) {
        Write-Log ('auto-merge PR #' + $prNum + ' (' + $sha7 + '): skipped (recorded in parked.json)')
        continue
      }

      # (b) Combined commit status context 'nyx/audit' on that SHA is 'success'.
      $statusRes = Invoke-Gh ('api repos/' + $Repo + '/commits/' + $headSha + '/status')
      if ($statusRes.exitCode -ne 0 -or [string]::IsNullOrWhiteSpace([string]$statusRes.text)) {
        Write-Log ('auto-merge PR #' + $prNum + ' (' + $sha7 + '): skipped (gh api commit status failed: ' + (ConvertTo-SingleLine (Get-ErrorSummary $statusRes) 180) + ')')
        continue
      }
      $statusObj = $null
      try {
        $statusObj = $statusRes.text | ConvertFrom-Json
      } catch {
        Write-Log ('auto-merge PR #' + $prNum + ' (' + $sha7 + '): skipped (could not parse commit status JSON: ' + (ConvertTo-SingleLine $_.Exception.Message 160) + ')')
        continue
      }
      $statusesRaw = Get-JsonProp $statusObj 'statuses'
      $statuses = @()
      if ($null -ne $statusesRaw) {
        $statuses = @($statusesRaw | Where-Object { $null -ne $_ })
      }
      $auditState = ''
      foreach ($st in $statuses) {
        if ([string](Get-JsonProp $st 'context') -ceq 'nyx/audit') {
          $auditState = ([string](Get-JsonProp $st 'state')).Trim().ToLowerInvariant()
          break
        }
      }
      if ($auditState -ne 'success') {
        $shownAudit = $auditState
        if (-not $shownAudit) { $shownAudit = 'missing' }
        Write-Log ('auto-merge PR #' + $prNum + ' (' + $sha7 + '): skipped (nyx/audit status is ' + $shownAudit + ', need success)')
        continue
      }

      # (d) mergeable is MERGEABLE and mergeStateStatus is not DIRTY.
      $viewRes = Invoke-Gh ('pr view ' + $prNum + ' -R ' + $Repo + ' --json mergeable,mergeStateStatus')
      if ($viewRes.exitCode -ne 0 -or [string]::IsNullOrWhiteSpace([string]$viewRes.text)) {
        Write-Log ('auto-merge PR #' + $prNum + ' (' + $sha7 + '): skipped (gh pr view failed: ' + (ConvertTo-SingleLine (Get-ErrorSummary $viewRes) 180) + ')')
        continue
      }
      $viewObj = $null
      try {
        $viewObj = $viewRes.text | ConvertFrom-Json
      } catch {
        Write-Log ('auto-merge PR #' + $prNum + ' (' + $sha7 + '): skipped (could not parse gh pr view JSON: ' + (ConvertTo-SingleLine $_.Exception.Message 160) + ')')
        continue
      }
      $mergeable = ([string](Get-JsonProp $viewObj 'mergeable')).Trim().ToUpperInvariant()
      $mergeState = ([string](Get-JsonProp $viewObj 'mergeStateStatus')).Trim().ToUpperInvariant()
      if ($mergeable -ne 'MERGEABLE') {
        $shownMergeable = $mergeable
        if (-not $shownMergeable) { $shownMergeable = 'empty' }
        $shownState = $mergeState
        if (-not $shownState) { $shownState = 'empty' }
        Write-Log ('auto-merge PR #' + $prNum + ' (' + $sha7 + '): skipped (mergeable is ' + $shownMergeable + ', mergeStateStatus is ' + $shownState + ')')
        continue
      }
      if ($mergeState -eq 'DIRTY') {
        Write-Log ('auto-merge PR #' + $prNum + ' (' + $sha7 + '): skipped (mergeStateStatus is DIRTY)')
        continue
      }

      # (e) Today's merges are under the daily cap (20).
      if (-not $mergedTodayLoaded) {
        $mergedToday = Get-TodayMergedNyxPrCount
        $mergedTodayLoaded = $true
      }
      if ($null -eq $mergedToday) {
        Write-Log ('auto-merge PR #' + $prNum + ' (' + $sha7 + '): skipped (could not count today merged nyx/ PRs)')
        continue
      }
      if ($mergedToday -ge $script:AutoMergeDailyCap) {
        Write-Log ('auto-merge PR #' + $prNum + ' (' + $sha7 + '): skipped (daily merge cap reached: ' + $mergedToday + '/' + $script:AutoMergeDailyCap + ')')
        continue
      }

      $prTitle = [regex]::Replace(([string](Get-JsonProp $pr 'title')), '[\r\n]+', ' ').Trim()
      if ([string]::IsNullOrWhiteSpace($prTitle)) { $prTitle = 'PR' }
      $subject = $prTitle + ' (#' + $prNum + ')'
      $cleanBody = Remove-AttributionLines $prBody
      if ([string]::IsNullOrWhiteSpace($cleanBody)) {
        $cleanBody = 'Closes #' + $issueNum
      } elseif ($cleanBody -notmatch $closingPattern) {
        $cleanBody = $cleanBody + "`n`nCloses #" + $issueNum
      }

      if ($isDryRun) {
        Write-Log ('auto-merge PR #' + $prNum + ' (' + $sha7 + '): skipped (dry-run; would merge issue #' + $issueNum + ')')
        continue
      }

      $bodyPath = Join-Path $script:AutopilotDir ('automerge-body-' + $prNum + '-' + [Guid]::NewGuid().ToString('N').Substring(0, 8) + '.md')
      $mergeRes = $null
      try {
        Write-Text $bodyPath ($cleanBody + "`n")
        $mergeArgs = 'pr merge ' + $prNum + ' -R ' + $Repo + ' --squash --match-head-commit ' + $headSha +
          ' --subject ' + (Quote-Win32Argument $subject) + ' --body-file ' + (Quote-Argument $bodyPath)
        $mergeRes = Invoke-Gh $mergeArgs
      } finally {
        Remove-Item -LiteralPath $bodyPath -Force -ErrorAction SilentlyContinue
      }

      if ($null -eq $mergeRes -or $mergeRes.exitCode -ne 0) {
        $errMsg = 'unknown error'
        if ($null -ne $mergeRes) { $errMsg = ConvertTo-SingleLine (Get-ErrorSummary $mergeRes) 200 }
        Write-Log ('auto-merge PR #' + $prNum + ' (' + $sha7 + '): skipped (gh pr merge failed: ' + $errMsg + ')')
        continue
      }

      $mergedToday++

      # Verify the merge commit message on main contains no agent attribution line.
      $mergeSha = ''
      for ($poll = 0; $poll -lt 2; $poll++) {
        $pullRes = Invoke-Gh ('api repos/' + $Repo + '/pulls/' + $prNum)
        if ($pullRes.exitCode -eq 0 -and -not [string]::IsNullOrWhiteSpace([string]$pullRes.text)) {
          try {
            $pullObj = $pullRes.text | ConvertFrom-Json
            $mergeSha = ([string](Get-JsonProp $pullObj 'merge_commit_sha')).Trim()
          } catch { }
        }
        if (-not [string]::IsNullOrWhiteSpace($mergeSha)) { break }
        if ($poll -eq 0) { Start-Sleep -Seconds 2 }
      }
      $mergeSha7 = 'unknown'
      if (-not [string]::IsNullOrWhiteSpace($mergeSha)) {
        $mergeSha7 = $mergeSha
        if ($mergeSha7.Length -gt 7) { $mergeSha7 = $mergeSha7.Substring(0, 7) }
        $commitRes = Invoke-Gh ('api repos/' + $Repo + '/commits/' + $mergeSha)
        if ($commitRes.exitCode -eq 0 -and -not [string]::IsNullOrWhiteSpace([string]$commitRes.text)) {
          try {
            $commitObj = $commitRes.text | ConvertFrom-Json
            $commitInner = Get-JsonProp $commitObj 'commit'
            $commitMsg = [string](Get-JsonProp $commitInner 'message')
            $badLine = ''
            foreach ($msgLine in ($commitMsg -split "`r?`n")) {
              if ($msgLine -match $script:AttributionLinePattern) {
                $badLine = $msgLine.Trim()
                break
              }
            }
            if (-not [string]::IsNullOrWhiteSpace($badLine)) {
              $alert = 'ALERT: auto-merge of PR #' + $prNum + ' produced merge commit ' + $mergeSha7 + ' on main with agent attribution line: ' + (ConvertTo-SingleLine $badLine 160)
              Write-Log $alert
              $null = Add-AuditLogComment $alert
            }
          } catch {
            Write-Log ('auto-merge PR #' + $prNum + ': warning: could not parse merge commit JSON for ' + $mergeSha7 + ': ' + (ConvertTo-SingleLine $_.Exception.Message 160))
          }
        } else {
          Write-Log ('auto-merge PR #' + $prNum + ': warning: could not fetch merge commit ' + $mergeSha7 + ' to verify message: ' + (ConvertTo-SingleLine (Get-ErrorSummary $commitRes) 160))
        }
      } else {
        Write-Log ('auto-merge PR #' + $prNum + ': warning: merge_commit_sha unavailable after merge; could not verify commit message on main')
      }

      Write-Log ('auto-merge PR #' + $prNum + ' (' + $sha7 + '): merged (issue #' + $issueNum + ', mergeCommit ' + $mergeSha7 + ', today ' + $mergedToday + '/' + $script:AutoMergeDailyCap + ')')

      # Close the linked issue with a comment if it is still open.
      $issueViewRes = Invoke-Gh ('issue view ' + $issueNum + ' -R ' + $Repo + ' --json state')
      if ($issueViewRes.exitCode -eq 0 -and -not [string]::IsNullOrWhiteSpace([string]$issueViewRes.text)) {
        try {
          $issueObj = $issueViewRes.text | ConvertFrom-Json
          $issueState = ([string](Get-JsonProp $issueObj 'state')).Trim().ToUpperInvariant()
          if ($issueState -eq 'OPEN') {
            $closeRes = Invoke-Gh ('issue close ' + $issueNum + ' -R ' + $Repo + ' --comment ' + (Quote-Argument ('Closed by #' + $prNum + '.')))
            if ($closeRes.exitCode -ne 0) {
              Write-Log ('auto-merge PR #' + $prNum + ': warning: failed to close linked issue #' + $issueNum + ': ' + (ConvertTo-SingleLine (Get-ErrorSummary $closeRes) 180))
            } else {
              Write-Log ('auto-merge PR #' + $prNum + ': closed linked issue #' + $issueNum)
            }
          }
        } catch {
          Write-Log ('auto-merge PR #' + $prNum + ': warning: could not parse issue #' + $issueNum + ' state: ' + (ConvertTo-SingleLine $_.Exception.Message 160))
        }
      } else {
        Write-Log ('auto-merge PR #' + $prNum + ': warning: could not check linked issue #' + $issueNum + ' state: ' + (ConvertTo-SingleLine (Get-ErrorSummary $issueViewRes) 180))
      }
    } catch {
      Write-Log ('auto-merge PR #' + $prNum + ': skipped (unexpected error: ' + (ConvertTo-SingleLine $_.Exception.Message 180) + ')')
    }
  }
}

function Invoke-WatchTick {
  if (Test-Stop) { return }

  $env:GH_PROMPT_DISABLED = '1'
  $env:GH_NO_UPDATE_NOTIFIER = '1'
  $env:GIT_TERMINAL_PROMPT = '0'
  $env:GCM_INTERACTIVE = 'never'

  $watchdog = Read-WatchdogState
  Invoke-SelfSync $watchdog

  $gh = Get-Command -Name 'gh' -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($gh) {
    $script:GhPath = $gh.Source
    try {
      Invoke-AutoMerge
    } catch {
      Write-Log ('auto-merge error: ' + (ConvertTo-SingleLine $_.Exception.Message 200))
    }
  } else {
    Write-Log 'auto-merge: skipped (gh was not found on PATH)'
  }

  if (-not (Test-Path -LiteralPath $script:PromptPath -PathType Leaf)) { throw 'autopilot.md is missing next to this script.' }
  if (-not (Test-Path -LiteralPath $script:WorkspacePath -PathType Container)) { throw '-Workspace does not exist.' }
  if (-not $script:GhPath) { throw 'GitHub CLI (gh) was not found on PATH.' }

  $nowUtc = [DateTime]::UtcNow
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

  $pState = ''
  $pStep = ''
  $pUpdatedAt = ''
  $progress = Read-JsonFile $script:ProgressPath
  if ($progress) {
    $pState = ([string](Get-JsonProp $progress 'state')).Trim().ToLowerInvariant()
    $pStep = ([string](Get-JsonProp $progress 'step')).Trim()
    $pUpdatedAt = ([string](Get-JsonProp $progress 'updatedAt')).Trim()
  }

  $lastKickoffOutcome = ([string]$watchdog['lastKickoffOutcome']).Trim().ToLowerInvariant()
  $lastKickoffUtcText = ([string]$watchdog['lastKickoffUtc']).Trim()
  $kickoffFailures = [int]$watchdog['kickoffFailures']
  $needsKickoff = $false
  $kickoffReason = ''
  if ($lastKickoffOutcome -eq 'failed') {
    $needsKickoff = $true
    $kickoffReason = 'lastKickoffOutcome is failed (failures=' + $kickoffFailures + ')'
  } elseif ([string]::IsNullOrWhiteSpace($lastKickoffUtcText) -and $pState -ne 'done' -and $pState -ne 'idle') {
    $needsKickoff = $true
    $kickoffReason = 'lastKickoffUtc is empty while progress state is "' + $pState + '"'
  }

  if ($needsKickoff) {
    if ($kickoffFailures -gt 3) {
      $lastAttemptUtc = Parse-UtcTimestamp ([string]$watchdog['lastKickoffAttemptUtc'])
      if ($null -ne $lastAttemptUtc) {
        $sinceAttemptMin = ($nowUtc - $lastAttemptUtc).TotalMinutes
        if ($sinceAttemptMin -lt 60) {
          Write-Log ('kickoff retry backed off (' + $kickoffFailures + ' consecutive failures; last attempt ' + [Math]::Round($sinceAttemptMin, 1) + 'm ago < 60m)')
          return
        }
      }
    }
    if ($kickoffFailures -ge 3) {
      $busyReset = @(Get-BusyAutopilotProcesses)
      if ($busyReset.Count -gt 0) {
        Write-Log ('kickoff reset deferred: ' + $busyReset.Count + ' task process(es) are running')
        return
      }
      Write-Log ('kickoff retry (' + $kickoffReason + '): performing full reset of Devin Desktop before relaunch')
      $null = Stop-DevinDesktop
      $null = Invoke-Kickoff -WaitForIdle $false
      return
    }
    Write-Log ('kickoff retry (' + $kickoffReason + '): calling Invoke-Kickoff')
    $null = Invoke-Kickoff -WaitForIdle $false
    return
  }

  $null = Close-ExtraDevinWindows $folder

  $window = [DevLoopWindows]::Find($folder)
  if ($window -eq [IntPtr]::Zero) {
    Write-Log 'no Devin Desktop window open; relaunching via kickoff'
    $null = Invoke-Kickoff -WaitForIdle $false
    return
  }

  if ($pState -eq 'idle' -and $pStep -match '(?i)daily merge cap') {
    $parsedUpdated = [DateTimeOffset]::MinValue
    if ([DateTimeOffset]::TryParse($pUpdatedAt, [Globalization.CultureInfo]::InvariantCulture, [Globalization.DateTimeStyles]::AssumeLocal, [ref]$parsedUpdated)) {
      if ($parsedUpdated.LocalDateTime.ToString('yyyy-MM-dd') -eq [DateTime]::Now.ToString('yyyy-MM-dd')) {
        Write-Log 'progress is idle on daily merge cap for today; skipping nudge'
        return
      }
    }
  }

  if ([int]$watchdog['consecutiveNudges'] -ge 6) {
    $busyOnRestart = @(Get-BusyAutopilotProcesses)
    if ($busyOnRestart.Count -gt 0) {
      Write-Log ('6 nudges reached, but ' + $busyOnRestart.Count + ' task process(es) are running; not restarting')
      return
    }
    if (-not [bool]$watchdog['stuckNotified']) {
      if (Send-StuckTrackingComment $watchdog) {
        $watchdog['stuckNotified'] = $true
        Save-WatchdogState $watchdog
      }
    }
    Write-Log 'autopilot unresponsive after 6 nudges with no new log activity; restarting Devin Desktop'
    $null = Stop-DevinDesktop
    $watchdog['consecutiveNudges'] = 0
    $watchdog['stuckNotified'] = $false
    Save-WatchdogState $watchdog
    $null = Invoke-Kickoff -WaitForIdle $false
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
      if (-not (Send-DevinTextSafe $window 'Bypass mode is on again. Continue where you left off.')) {
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
    $soloPlan = Join-Path $PSScriptRoot 'solo-v3.md'
    $soloStatePath = Join-Path $script:AutopilotDir 'solo-v3.json'
    $soloState = Read-JsonFile $soloStatePath
    $soloPhase = ''
    if ($soloState) { $soloPhase = ([string](Get-JsonProp $soloState 'phase')).Trim().ToLowerInvariant() }
    $inPolling = ($pState -eq 'polling' -or $pState -eq 'done')
    if ($soloState -and (Test-Path -LiteralPath $soloPlan) -and $soloPhase -ne 'polling' -and $soloPhase -ne 'done') {
      $inPolling = $false
    }
    if ($inPolling) {
      $workRemains = Test-WorkRemains
      if ($null -eq $workRemains) { return }
      if (-not $workRemains) {
        Write-Log ('no log write for ' + [Math]::Round($idleMin, 1) + 'm while polling, and no open unparked ' + $Label + ' issues remain; idle')
        return
      }
    }
    # A long npm run verify, gate, packaging, or smoke run writes nothing to Devin's log; the agent is busy, not stuck.
    $busy = @(Get-BusyAutopilotProcesses)
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
    $nudgeMessage = 'Continue the autopilot task: first re-read ' + $script:PromptPath + ', then check open nyx/ PRs on GitHub and ' + $script:ProgressPath + '. Never merge PRs yourself: the watchdog merges any PR whose gate passed and nyx/audit is success on the exact head. Any open nyx/ PR whose current head has no passing gate needs Invoke-AutopilotGate.ps1 run on that head before any new issue starts. Keep going (queue, parked revisits, hands-on milestone, and 30-minute polling). With 3 or more open non-parked nyx/ PRs, start no new issue: fix, gate and finish the open ones first.'
    # The v3 solo mission supersedes the per-issue loop while its state file says it is not finished.
    if ($soloState -and (Test-Path -LiteralPath $soloPlan) -and $soloPhase -ne 'done') {
      $nudgeMessage = 'Continue the mission: first re-read ' + $soloPlan + ' and ' + $script:PromptPath + ', then check open nyx/ PRs on GitHub, ' + $script:ProgressPath + ', and ' + $soloStatePath + '. Never merge PRs yourself: the watchdog merges any PR whose gate passed and nyx/audit is success on the exact head. Any open nyx/ PR whose current head has no passing gate needs Invoke-AutopilotGate.ps1 run on that head before any new issue starts. Keep working through every phase, milestone, and polling cycle without waiting for a person. Do not end your turn with a checkpoint while work remains. With 3 or more open non-parked nyx/ PRs, start no new issue: fix, gate and finish the open ones first.'
    }
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
    '-IntervalMinutes', [string]$IntervalMinutes,
    '-SyncSource', (Quote-Argument $SyncSource),
    '-SyncTarget', (Quote-Argument $SyncTarget)
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

  $redact = @($script:WorkRoot, $script:WorkspacePath, $env:USERPROFILE, $script:AcceptanceRepo, $SyncSource, $SyncTarget)
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
