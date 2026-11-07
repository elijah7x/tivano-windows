# Tivano Windows — derived from Tivano (AGPL-3.0), modified 2026-10-24.
# Droppy Code by Jordy Spruit (Droppy), https://getdroppycode.app
#
# build-job-helper.ps1 — reproducible x64 build of the Windows job helper
# and its multi-generation test fixture. PREREQUISITES (not installed by
# this script — install them yourself first):
#   · Visual Studio Build Tools with the "C++ build tools" workload
#     (cl.exe, link.exe), and
#   · Windows 10 SDK.
# The script NEVER installs toolchains silently and NEVER fetches sources:
# all inputs are already in the repo (third_party is vendored, hash-pinned).
#
# Usage (from a plain PowerShell prompt — the script finds the toolchain):
#   powershell -ExecutionPolicy Bypass -File scripts\build-job-helper.ps1 `
#     -OutDir D:\tivano-evidence\helper-build
#
# -OutDir is a caller-supplied EXTERNAL directory that must not exist yet
# or be completely EMPTY — the build never reuses or deletes existing
# outputs, so a stale binary can never pass as a fresh build. A sibling
# directory of the repo is allowed; anything INSIDE the source tree is
# refused, checked component-by-component (not by string prefix, so
# "repo2" is not "inside repo").
#
# Toolchain environment is imported into THIS PowerShell process by
# running vcvars64.bat and capturing its environment dump — no .cmd
# wrapper means no ANSI/Unicode mangling of non-ASCII paths, and every
# cl/link step is checked at its own $LASTEXITCODE under StrictMode.
#
# Outputs: tivano-job-helper.exe, job-fixture.exe, codex-launcher.exe,
# terminal-fixture.exe, build-manifest.json (compiler/SDK versions,
# source+binary SHA-256, flags), build.log, obj\.
# Executables are NEVER committed.

param(
  [Parameter(Mandatory = $true)]
  [string]$OutDir
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

$repo = Split-Path -Parent $PSScriptRoot
$helperDir = Join-Path $repo "helpers\win32"
$fixtureSrc = Join-Path $repo "tests\windows\job-fixture.cpp"
$launcherSrc = Join-Path $repo "tests\windows\codex-launcher.cpp"
$terminalFixtureSrc = Join-Path $repo "tests\windows\terminal-fixture.cpp"
$sources = @(
  (Join-Path $helperDir "tivano-job-helper.cpp"),
  (Join-Path $helperDir "helper_common.cpp"),
  (Join-Path $helperDir "helper_common.hpp"),
  (Join-Path $helperDir "helper_win32.cpp"),
  (Join-Path $helperDir "helper_win32.hpp"),
  (Join-Path $helperDir "terminal_mode.cpp"),
  (Join-Path $helperDir "terminal_mode.hpp"),
  (Join-Path $helperDir "third_party\nlohmann\json.hpp"),
  $fixtureSrc,
  $launcherSrc,
  $terminalFixtureSrc
)
foreach ($s in $sources) {
  if (-not (Test-Path -LiteralPath $s -PathType Leaf)) {
    Write-Error "missing source: $s"
  }
}

# ---- output directory: external, fresh, component-checked -------------------
# Validate the path BEFORE creating anything: resolve the deepest existing
# ancestor first so a bogus drive/root is an error, not a created dir.
$candidate = $ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($OutDir)
$alreadyExists = Test-Path -LiteralPath $candidate
if ($alreadyExists) {
  if (-not (Test-Path -LiteralPath $candidate -PathType Container)) { Write-Error "-OutDir is not a directory" }
  $resolved = (Resolve-Path -LiteralPath $candidate).Path
  if (@(Get-ChildItem -LiteralPath $resolved -Force).Count -ne 0) { Write-Error "-OutDir must be empty" }
} else {
  $parent = Split-Path -Parent $candidate
  if (-not (Test-Path -LiteralPath $parent -PathType Container)) { Write-Error "-OutDir parent must already exist" }
  $resolved = Join-Path (Resolve-Path -LiteralPath $parent).Path (Split-Path -Leaf $candidate)
}
$repoResolved = (Resolve-Path -LiteralPath $repo).Path.TrimEnd('\')
if ($resolved.Equals($repoResolved, [System.StringComparison]::OrdinalIgnoreCase) -or
    $resolved.StartsWith($repoResolved + '\', [System.StringComparison]::OrdinalIgnoreCase)) {
  Write-Error "-OutDir must be OUTSIDE the source tree: $resolved"
}
if (-not $alreadyExists) { New-Item -ItemType Directory -Path $resolved | Out-Null }
$OutDir = $resolved
$objDir = Join-Path $OutDir "obj"
New-Item -ItemType Directory -Force -Path $objDir | Out-Null
$logPath = Join-Path $OutDir "build.log"

# Verify the vendored json.hpp against the pinned release hash — a build
# NEVER proceeds on an unverifiable third-party file.
$jsonHash = (Get-FileHash -Algorithm SHA256 -LiteralPath `
    (Join-Path $helperDir "third_party\nlohmann\json.hpp")).Hash.ToLower()
$expected = "aaf127c04cb31c406e5b04a63f1ae89369fccde6d8fa7cdda1ed4f32dfc5de63"
if ($jsonHash -ne $expected) {
  Write-Error "third_party\nlohmann\json.hpp SHA-256 mismatch: $jsonHash (expected $expected)"
}

# ---- locate MSVC + SDK -----------------------------------------------------
$vswhere = "${env:ProgramFiles(x86)}\Microsoft Visual Studio\Installer\vswhere.exe"
if (-not (Test-Path -LiteralPath $vswhere)) {
  Write-Error "vswhere.exe not found — install Visual Studio Build Tools (C++ workload) first."
}
$vsPath = & $vswhere -latest -products * -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath
if (-not $vsPath) {
  Write-Error "no MSVC x64 toolchain found — install the 'C++ build tools' workload first."
}
$vcvars = Join-Path $vsPath "VC\Auxiliary\Build\vcvars64.bat"
if (-not (Test-Path -LiteralPath $vcvars)) {
  Write-Error "vcvars64.bat missing under $vsPath"
}

# ---- import the vcvars environment INTO this process ------------------------
# `set` output is Unicode-safe through cmd -> PowerShell capture (no batch
# file on disk, no ANSI-encoded command lines). Values may contain '=' —
# split on the FIRST one only.
$start = New-Object System.Diagnostics.ProcessStartInfo
$start.FileName = $env:ComSpec
$start.Arguments = '/d /u /s /c ""' + $vcvars + '" >nul 2>nul && set"'
$start.UseShellExecute = $false
$start.CreateNoWindow = $true
$start.RedirectStandardOutput = $true
$start.StandardOutputEncoding = [System.Text.Encoding]::Unicode
$proc = [System.Diagnostics.Process]::Start($start)
$envText = $proc.StandardOutput.ReadToEnd()
$proc.WaitForExit()
$envExit = $proc.ExitCode
$proc.Dispose()
if ($envExit -ne 0) { Write-Error "vcvars64.bat failed (exit $envExit)" }
$envDump = $envText -split "`r?`n"
foreach ($line in $envDump) {
  $i = $line.IndexOf('=')
  if ($i -gt 0) {
    [Environment]::SetEnvironmentVariable(
      $line.Substring(0, $i), $line.Substring($i + 1), "Process")
  }
}
$cl = Get-Command cl.exe -ErrorAction SilentlyContinue
$lnk = Get-Command link.exe -ErrorAction SilentlyContinue
if (-not $cl -or -not $lnk) {
  Write-Error "vcvars env imported but cl.exe/link.exe not on PATH — toolchain unverifiable"
}

# ---- compile every TU, fail on the spot -------------------------------------
# A helper function keeps the fail-fast check literal — no || chains whose
# semantics change under different shells.
$logWriter = [System.IO.StreamWriter]::new($logPath, $false,
  (New-Object System.Text.UTF8Encoding($false)))
function Invoke-Logged([string]$exe, [string[]]$cmdArgs, [string]$step) {
  $logWriter.WriteLine("== $step =="); $logWriter.WriteLine("$exe $($cmdArgs -join ' ')")
  $previousPreference = $ErrorActionPreference
  try {
    # Windows PowerShell wraps native stderr as ErrorRecord. Preserve it
    # as evidence and use the actual process exit code for failure.
    $ErrorActionPreference = "Continue"
    $out = @(& $exe @cmdArgs 2>&1)
    $code = $LASTEXITCODE
  } finally { $ErrorActionPreference = $previousPreference }
  foreach ($l in $out) { $logWriter.WriteLine($l) }
  $logWriter.Flush()
  if ($code -ne 0) {
    $logWriter.Close()
    Write-Error ("$step failed (exit $code) — full log at $logPath; " +
      "NO binary from this run is trustworthy")
  }
  return ,$out
}

$flags = @(
  "/nologo", "/std:c++17", "/W4", "/WX", "/O2", "/EHsc", "/utf-8",
  "/DUNICODE", "/D_UNICODE", "/DWIN32_LEAN_AND_MEAN", "/DNOMINMAX",
  "/D_WIN32_WINNT=0x0A00", "/DWINVER=0x0A00",
  "/MT", "/I", $helperDir
)
$helperObj = Join-Path $objDir "helper.obj"
$commonObj = Join-Path $objDir "helper_common.obj"
$win32Obj = Join-Path $objDir "helper_win32.obj"
$termModeObj = Join-Path $objDir "terminal_mode.obj"
$fixtureObj = Join-Path $objDir "job-fixture.obj"
$launcherObj = Join-Path $objDir "codex-launcher.obj"
$termFixtureObj = Join-Path $objDir "terminal-fixture.obj"
$helperExe = Join-Path $OutDir "tivano-job-helper.exe"
$fixtureExe = Join-Path $OutDir "job-fixture.exe"
$launcherExe = Join-Path $OutDir "codex-launcher.exe"
$termFixtureExe = Join-Path $OutDir "terminal-fixture.exe"

# /Bv rides on a REAL compile (front/back-end banners): a no-source `cl /Bv`
# invocation only reports a missing-input error, not a version.
$commonOut = Invoke-Logged $cl.Source (@($flags; "/Bv"; "/c";
    (Join-Path $helperDir "helper_common.cpp"); "/Fo$commonObj")) "compile helper_common"
$clBanner = ($commonOut | ForEach-Object { $_.ToString() }) -join "`n"
Invoke-Logged $cl.Source (@($flags; "/c";
    (Join-Path $helperDir "helper_win32.cpp"); "/Fo$win32Obj")) "compile helper_win32"
Invoke-Logged $cl.Source (@($flags; "/c";
    (Join-Path $helperDir "terminal_mode.cpp"); "/Fo$termModeObj")) "compile terminal_mode"
Invoke-Logged $cl.Source (@($flags; "/c";
    (Join-Path $helperDir "tivano-job-helper.cpp"); "/Fo$helperObj")) "compile tivano-job-helper"
Invoke-Logged $lnk.Source (@("/nologo", $helperObj, $commonObj, $win32Obj,
    $termModeObj, "/OUT:$helperExe")) "link tivano-job-helper"
Invoke-Logged $cl.Source (@($flags; "/c"; $fixtureSrc;
    "/Fo$fixtureObj")) "compile job-fixture"
Invoke-Logged $lnk.Source (@("/nologo", $fixtureObj,
    "/OUT:$fixtureExe")) "link job-fixture"
# codex-launcher — packaged-job TEST payload (protocol fixture, never shipped).
Invoke-Logged $cl.Source (@($flags; "/c"; $launcherSrc;
    "/Fo$launcherObj")) "compile codex-launcher"
Invoke-Logged $lnk.Source (@("/nologo", $launcherObj,
    "/OUT:$launcherExe")) "link codex-launcher"
# terminal-fixture — terminal-mode TEST payload (in-job canary/marker child,
# never shipped).
Invoke-Logged $cl.Source (@($flags; "/c"; $terminalFixtureSrc;
    "/Fo$termFixtureObj")) "compile terminal-fixture"
Invoke-Logged $lnk.Source (@("/nologo", $termFixtureObj,
    "/OUT:$termFixtureExe")) "link terminal-fixture"
$logWriter.Close()

# ---- evidence manifest ------------------------------------------------------
$manifest = [ordered]@{
  builtAtUtc          = (Get-Date).ToUniversalTime().ToString("o")
  compilerBanner      = $clBanner
  vcToolsVersion      = $env:VCToolsVersion
  windowsSdkVersion   = $env:WindowsSDKVersion
  ucrtVersion         = $env:UCRTVersion
  osVersion           = [System.Environment]::OSVersion.VersionString
  machine             = $env:PROCESSOR_ARCHITECTURE
  flags               = $flags -join " "
  sources             = @{}
  outputs             = @{}
}
foreach ($s in $sources) {
  $manifest.sources[(Split-Path -Leaf $s)] =
    (Get-FileHash -Algorithm SHA256 -LiteralPath $s).Hash.ToLower()
}
foreach ($exe in @("tivano-job-helper.exe", "job-fixture.exe", "codex-launcher.exe", "terminal-fixture.exe")) {
  $p = Join-Path $OutDir $exe
  if (-not (Test-Path -LiteralPath $p)) { Write-Error "expected output missing: $exe" }
  $manifest.outputs[$exe] = (Get-FileHash -Algorithm SHA256 -LiteralPath $p).Hash.ToLower()
}
$manifest | ConvertTo-Json -Depth 4 |
  Set-Content -LiteralPath (Join-Path $OutDir "build-manifest.json") -Encoding UTF8

Write-Host ""
Write-Host "build complete -> $OutDir"
Write-Host "  tivano-job-helper.exe  sha256=$($manifest.outputs['tivano-job-helper.exe'])"
Write-Host "  job-fixture.exe        sha256=$($manifest.outputs['job-fixture.exe'])"
Write-Host "  codex-launcher.exe     sha256=$($manifest.outputs['codex-launcher.exe'])"
Write-Host "  terminal-fixture.exe   sha256=$($manifest.outputs['terminal-fixture.exe'])"
Write-Host "  manifest: $(Join-Path $OutDir 'build-manifest.json')"
