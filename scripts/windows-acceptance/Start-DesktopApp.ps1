# Tivano Windows - derived from Tivano (AGPL-3.0), modified 2026-11-07.
# Droppy Code by Jordy Spruit (Droppy), https://getdroppycode.app
# Usage: .\Start-DesktopApp.ps1 -Repo $repo -Evidence $freshDir [-Exe $packagedExe]

param(
  [string]$Repo,
  [string]$Evidence,
  [string]$DataRoot,
  [string]$Provider = 'mock',
  [string]$Exe
)

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'Invoke-InteractiveSession.ps1')
$script:AcceptanceCommand = 'Start-DesktopApp'
$status = 1
try {
  $dir = Test-AcceptanceEvidence $Evidence
  $repoPath = Get-AcceptancePath $Repo
  if (-not (Test-Path -LiteralPath $repoPath -PathType Container)) { throw '-Repo must exist.' }
  Assert-AcceptanceOutsideRepo $dir @($script:AcceptanceRepo, $repoPath)
  if ([string]::IsNullOrWhiteSpace($Provider)) { throw '-Provider cannot be empty.' }
  $appArguments = @()
  if ($Exe) {
    $exePath = Get-AcceptancePath $Exe
  } else {
    foreach ($output in @('dist\main\index.cjs', 'dist\main\ptyHost.cjs', 'dist\preload\index.cjs',
        'dist\renderer\index.html', 'dist\renderer\renderer.js', 'dist\renderer\styles.css')) {
      if (-not (Test-Path -LiteralPath (Join-Path $repoPath $output) -PathType Leaf)) {
        throw "Bundle is not built: missing $output. Build it separately before acceptance."
      }
    }
    $exePath = Join-Path $repoPath 'node_modules\electron\dist\electron.exe'
    $appArguments = @($repoPath)
  }
  if (-not (Test-Path -LiteralPath $exePath -PathType Leaf)) { throw 'Application executable is missing.' }
  if (-not $DataRoot) { $DataRoot = Join-Path $dir 'data-root' }
  $dataPath = Get-AcceptancePath $DataRoot
  Assert-AcceptanceOutsideRepo $dataPath @($script:AcceptanceRepo, $repoPath)
  if ((Test-Path -LiteralPath $dataPath) -and -not (Test-Path -LiteralPath $dataPath -PathType Container)) {
    throw '-DataRoot must be a directory.'
  }
  $config = @{
    repo = $repoPath; exe = $exePath; arguments = $appArguments
    evidence = $dir; dataRoot = $dataPath; provider = $Provider
  } | ConvertTo-Json -Compress
  $encoded = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($config))
  $payload = '$config = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String(' +
    (ConvertTo-AcceptanceLiteral $encoded) + ')) | ConvertFrom-Json' + "`r`n" + @'
$ErrorActionPreference = 'Stop'
Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue
$env:TIVANO_DATA_ROOT = $config.dataRoot
$env:TIVANO_PROVIDER = $config.provider
[IO.Directory]::CreateDirectory($config.dataRoot) | Out-Null
$launch = @{
  FilePath = $config.exe; WorkingDirectory = $config.repo; PassThru = $true
  RedirectStandardOutput = (Join-Path $config.evidence 'app.out.log')
  RedirectStandardError = (Join-Path $config.evidence 'app.err.log')
}
if (@($config.arguments).Count) { $launch.ArgumentList = '"' + $config.arguments[0] + '"' }
$app = Start-Process @launch
$appId = $app.Id
[IO.File]::WriteAllText((Join-Path $config.evidence 'app.pid'), [string]$appId)
$identity = @{
  pid = $appId; startedAtUtc = $app.StartTime.ToUniversalTime().ToString('o')
  executable = $config.exe; sessionId = $app.SessionId
}
$identity | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $config.evidence 'app-process.json') -Encoding UTF8
$clock = [Diagnostics.Stopwatch]::StartNew()
$window = $null
while ($clock.Elapsed.TotalSeconds -lt 30) {
  $processes = @(Get-CimInstance Win32_Process -Filter "SessionId = $($app.SessionId)")
  $tree = @($appId)
  do {
    $children = @($processes | Where-Object {
      $_.ParentProcessId -in $tree -and $_.ProcessId -notin $tree -and
      $_.CreationDate.ToUniversalTime() -ge $app.StartTime.ToUniversalTime()
    } | ForEach-Object { [int]$_.ProcessId })
    $tree += $children
  } while ($children.Count)
  foreach ($processId in $tree) {
    $process = Get-Process -Id $processId -ErrorAction SilentlyContinue
    if ($process -and $process.MainWindowHandle -ne [IntPtr]::Zero) { $window = $process; break }
  }
  if ($window) { break }
  Start-Sleep -Milliseconds 250
}
if (-not $window) { throw 'No main window appeared in the launched process tree within 30 seconds; app.pid is retained for cleanup.' }
@{ pid = $appId; windowPid = $window.Id; windowTitle = $window.MainWindowTitle } |
  ConvertTo-Json | Set-Content -LiteralPath (Join-Path $config.evidence 'launch.json') -Encoding UTF8
'@
  $child = Invoke-InInteractiveSession -Evidence $dir -Name launch -ScriptBlockText $payload -NoWait
  if ($null -ne $child.exitCode -and $child.exitCode -ne 0) { throw 'Interactive launcher failed; see launch.err.log.' }
  $clock = [Diagnostics.Stopwatch]::StartNew()
  $resultPath = Join-Path $dir 'launch.json'
  $exitPath = Join-Path $dir 'launch.exit.json'
  while (-not (Test-Path -LiteralPath $exitPath) -and $clock.Elapsed.TotalSeconds -lt 45) {
    Start-Sleep -Milliseconds 200
  }
  if (-not (Test-Path -LiteralPath $exitPath)) { throw 'Interactive launcher did not finish; see launch.err.log and app.pid.' }
  $completion = Get-Content -LiteralPath $exitPath -Raw | ConvertFrom-Json
  if ($completion.exitCode -ne 0 -or -not (Test-Path -LiteralPath $resultPath)) {
    throw 'Interactive app launch failed; see launch.err.log and app.err.log.'
  }
  $launched = Get-Content -LiteralPath $resultPath -Raw | ConvertFrom-Json
  $summary = [ordered]@{
    ok = $true; exitCode = 0; pid = $launched.pid; windowPid = $launched.windowPid
    windowTitle = $launched.windowTitle; provider = $Provider; dataRoot = $dataPath
    stdoutPath = (Join-Path $dir 'app.out.log'); stderrPath = (Join-Path $dir 'app.err.log')
  }
  $status = 0
} catch {
  $summary = [ordered]@{ ok = $false; exitCode = 1; error = $_.Exception.Message }
}
Write-AcceptanceSummary $summary
exit $status
