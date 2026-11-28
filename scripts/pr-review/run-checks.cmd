@echo off
rem Tivano Windows - derived from Tivano (AGPL-3.0), modified 2026-11-28.
rem Droppy Code by Jordy Spruit (Droppy), https://getdroppycode.app
rem Usage: run-checks.cmd <worktree> <results-dir>
rem Started by Invoke-AsStandardUser.ps1 so nothing here runs as the operating account.
rem Writes steps.json, vitest.json, unit.log, e2e.log, build.log, typecheck.log and install.log.
rem Exits 0 whenever the script itself completed; per-step results are in steps.json.

setlocal DisableDelayedExpansion
set "WT=%~1"
set "RES=%~2"
if "%WT%"=="" exit /b 2
if "%RES%"=="" exit /b 2
if not exist "%WT%\" exit /b 2
if not exist "%RES%\" mkdir "%RES%"
if not exist "%RES%\" exit /b 2
if not defined TIVANO_GATE_VITEST_WORKERS set "TIVANO_GATE_VITEST_WORKERS=4"
if "%TIVANO_GATE_VITEST_WORKERS%"=="" set "TIVANO_GATE_VITEST_WORKERS=4"

rem Every step starts as null ("not run") so a skipped step is never reported as passing.
set "STEP_INSTALL=null"
set "STEP_BUILD=null"
set "STEP_TYPECHECK=null"
set "STEP_UNIT=null"
set "STEP_E2E=null"
set "STEP_E2E_SKIPPED=false"

pushd "%WT%"
if errorlevel 1 (
  > "%RES%\steps.json" echo {"error":"cannot enter the worktree","install":null,"build":null,"typecheck":null,"unit":null,"e2e":null}
  echo {"ok":1}
  exit /b 0
)

call npm.cmd ci --no-audit --no-fund > "%RES%\install.log" 2>&1
set "STEP_INSTALL=%ERRORLEVEL%"
if not "%STEP_INSTALL%"=="0" goto :finish

call npm.cmd run build > "%RES%\build.log" 2>&1
set "STEP_BUILD=%ERRORLEVEL%"
if not "%STEP_BUILD%"=="0" goto :finish

rem Typecheck and tests are independent, so a typecheck failure still records test results.
call npm.cmd run typecheck > "%RES%\typecheck.log" 2>&1
set "STEP_TYPECHECK=%ERRORLEVEL%"

call node.exe ".\node_modules\vitest\vitest.mjs" run --maxWorkers=%TIVANO_GATE_VITEST_WORKERS% --reporter=default --reporter=json "--outputFile.json=%RES%\vitest.json" > "%RES%\unit.log" 2>&1
set "STEP_UNIT=%ERRORLEVEL%"

if "%TIVANO_GATE_SKIP_E2E%"=="1" goto :skip_e2e

rem e2e is capped at 15 minutes; exit code 124 means it was stopped at the cap.
powershell.exe -NoProfile -NonInteractive -Command "$p = Start-Process -FilePath node.exe -ArgumentList 'scripts\e2e.mjs' -NoNewWindow -PassThru -RedirectStandardOutput '%RES%\e2e.log' -RedirectStandardError '%RES%\e2e.err.log'; if ($p.WaitForExit(900000)) { exit $p.ExitCode } else { taskkill.exe /T /F /PID $p.Id | Out-Null; exit 124 }"
set "STEP_E2E=%ERRORLEVEL%"
rem Electron instances left behind by a failed e2e would otherwise outlive the run. Only this worktree's Electron is stopped, so a concurrent gate's e2e keeps running.
powershell.exe -NoProfile -NonInteractive -Command "$w = '%WT%'.TrimEnd('\\'); Get-CimInstance Win32_Process -Filter \"Name='electron.exe'\" | Where-Object { $_.ExecutablePath -and $_.ExecutablePath.StartsWith($w, [StringComparison]::OrdinalIgnoreCase) } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }" > nul 2>&1
goto :finish

:skip_e2e
set "STEP_E2E=0"
set "STEP_E2E_SKIPPED=true"
> "%RES%\e2e.log" echo e2e skipped (docs/tests-only change)

:finish
popd
if exist "%RES%" (
  if "%STEP_E2E_SKIPPED%"=="true" (
    > "%RES%\steps.json" echo {"install":%STEP_INSTALL%,"build":%STEP_BUILD%,"typecheck":%STEP_TYPECHECK%,"unit":%STEP_UNIT%,"e2e":%STEP_E2E%,"e2eSkipped":true}
  ) else (
    > "%RES%\steps.json" echo {"install":%STEP_INSTALL%,"build":%STEP_BUILD%,"typecheck":%STEP_TYPECHECK%,"unit":%STEP_UNIT%,"e2e":%STEP_E2E%}
  )
)
set "STATUS=1"
if "%STEP_INSTALL%%STEP_BUILD%%STEP_TYPECHECK%%STEP_UNIT%%STEP_E2E%"=="00000" set "STATUS=0"
echo {"ok":%STATUS%}
exit /b 0
