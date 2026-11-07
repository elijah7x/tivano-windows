# Tivano Windows - derived from Tivano (AGPL-3.0), modified 2026-11-07.
# Droppy Code by Jordy Spruit (Droppy), https://getdroppycode.app
# Usage: .\Save-Screenshot.ps1 -Evidence $freshDir -Name overview [-WindowTitle 'Tivano']

param([string]$Evidence, [string]$Name, [string]$WindowTitle)

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'Invoke-InteractiveSession.ps1')
$script:AcceptanceCommand = 'Save-Screenshot'
$status = 1
try {
  $dir = Test-AcceptanceEvidence $Evidence
  Assert-AcceptanceSlug $Name
  $png = Join-Path $dir "$Name.png"
  if (Test-Path -LiteralPath $png) { throw 'Screenshot already exists.' }
  $resultPath = Join-Path $dir "$Name.capture.json"
  $config = @{ png = $png; result = $resultPath; title = $WindowTitle } | ConvertTo-Json -Compress
  $encoded = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($config))
  $payload = '$config = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String(' +
    (ConvertTo-AcceptanceLiteral $encoded) + ')) | ConvertFrom-Json' + "`r`n" + @'
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @"
using System;
using System.Text;
using System.Runtime.InteropServices;
namespace TivanoAcceptance {
  public static class Capture {
    [StructLayout(LayoutKind.Sequential)] public struct Rect { public int Left, Top, Right, Bottom; }
    public delegate bool EnumProc(IntPtr hwnd, IntPtr param);
    [DllImport("user32.dll", SetLastError = true)] public static extern bool SetProcessDpiAwarenessContext(IntPtr context);
    [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
    [DllImport("user32.dll")] public static extern int GetSystemMetrics(int index);
    [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc callback, IntPtr param);
    [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr hwnd);
    [DllImport("user32.dll")] static extern bool IsIconic(IntPtr hwnd);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetWindowText(IntPtr hwnd, StringBuilder text, int max);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetWindowTextLength(IntPtr hwnd);
    [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr hwnd, out Rect rect);
    [DllImport("dwmapi.dll")] static extern int DwmGetWindowAttribute(IntPtr hwnd, int attribute, out Rect rect, int size);
    public static Rect WindowBounds(string title) {
      IntPtr found = IntPtr.Zero;
      EnumWindows(delegate(IntPtr hwnd, IntPtr unused) {
        if (!IsWindowVisible(hwnd)) return true;
        var text = new StringBuilder(GetWindowTextLength(hwnd) + 1);
        GetWindowText(hwnd, text, text.Capacity);
        if (text.ToString().IndexOf(title, StringComparison.OrdinalIgnoreCase) < 0) return true;
        found = hwnd;
        return false;
      }, IntPtr.Zero);
      if (found == IntPtr.Zero) throw new InvalidOperationException("No visible window matches the title.");
      if (IsIconic(found)) throw new InvalidOperationException("The matching window is minimized; restore it before capturing.");
      Rect rect;
      int result = -1;
      try { result = DwmGetWindowAttribute(found, 9, out rect, Marshal.SizeOf(typeof(Rect))); }
      catch (DllNotFoundException) { rect = new Rect(); }
      catch (EntryPointNotFoundException) { rect = new Rect(); }
      if (result != 0 && !GetWindowRect(found, out rect)) throw new InvalidOperationException("Cannot read the window rectangle.");
      return rect;
    }
  }
}
"@
$aware = $false
try { $aware = [TivanoAcceptance.Capture]::SetProcessDpiAwarenessContext([IntPtr](-4)) }
catch [Management.Automation.MethodInvocationException] { $aware = $false }
if (-not $aware) { [void][TivanoAcceptance.Capture]::SetProcessDPIAware() }
Add-Type -AssemblyName System.Drawing
if ($config.title) {
  $rect = [TivanoAcceptance.Capture]::WindowBounds($config.title)
  $left = $rect.Left; $top = $rect.Top
  $width = $rect.Right - $rect.Left; $height = $rect.Bottom - $rect.Top
} else {
  $left = [TivanoAcceptance.Capture]::GetSystemMetrics(76)
  $top = [TivanoAcceptance.Capture]::GetSystemMetrics(77)
  $width = [TivanoAcceptance.Capture]::GetSystemMetrics(78)
  $height = [TivanoAcceptance.Capture]::GetSystemMetrics(79)
}
if ($width -le 0 -or $height -le 0) { throw 'Capture rectangle is empty.' }
$bitmap = $null; $graphics = $null; $file = $null
try {
  $bitmap = New-Object Drawing.Bitmap($width, $height)
  $graphics = [Drawing.Graphics]::FromImage($bitmap)
  $graphics.CopyFromScreen($left, $top, 0, 0, $bitmap.Size, [Drawing.CopyPixelOperation]::SourceCopy)
  $file = [IO.File]::Open($config.png, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
  $bitmap.Save($file, [Drawing.Imaging.ImageFormat]::Png)
} finally {
  if ($file) { $file.Dispose() }
  if ($graphics) { $graphics.Dispose() }
  if ($bitmap) { $bitmap.Dispose() }
}
@{ width = $width; height = $height; left = $left; top = $top } |
  ConvertTo-Json | Set-Content -LiteralPath $config.result -Encoding UTF8
'@
  $child = Invoke-InInteractiveSession -Evidence $dir -Name $Name -ScriptBlockText $payload
  if ($child.exitCode -ne 0) { throw "Screenshot task failed with exit code $($child.exitCode); see $Name.err.log." }
  $capture = Get-Content -LiteralPath $resultPath -Raw | ConvertFrom-Json
  $summary = [ordered]@{
    ok = $true; exitCode = 0; png = $png; width = $capture.width; height = $capture.height
    left = $capture.left; top = $capture.top; windowTitle = $WindowTitle
  }
  $status = 0
} catch {
  $summary = [ordered]@{ ok = $false; exitCode = 1; error = $_.Exception.Message }
}
Write-AcceptanceSummary $summary
exit $status
