# Tivano Windows - derived from Tivano (AGPL-3.0), modified 2026-11-07.
# Droppy Code by Jordy Spruit (Droppy), https://getdroppycode.app
# Usage: .\Invoke-AsStandardUser.ps1 -CredentialFile $credentialFile -Evidence $freshDir -Command $exe -Arguments $arguments

param(
  [string]$CredentialFile,
  [string]$Evidence,
  [string]$Command,
  [string[]]$Arguments = @(),
  [string]$WorkingDirectory,
  [ValidateRange(1, 86400)][int]$TimeoutSec = 900
)

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'Invoke-InteractiveSession.ps1')
$script:AcceptanceCommand = 'Invoke-AsStandardUser'
$registered = $false
$completed = $false
$status = 1
$oldTemp = $env:TEMP
$oldTmp = $env:TMP
$credential = $null
$plainPassword = $null
try {
  $dir = Test-AcceptanceEvidence $Evidence
  if ($dir.Contains('%') -or $dir.Contains("`r") -or $dir.Contains("`n")) {
    throw '-Evidence cannot contain percent signs or newlines because the wrapper uses cmd.exe.'
  }
  $credentialPath = Get-AcceptancePath $CredentialFile
  Assert-AcceptanceOutsideRepo $credentialPath
  if ($credentialPath.EndsWith('.json', [StringComparison]::OrdinalIgnoreCase)) {
    # Machine-scope DPAPI: user-scope keys are often unavailable in key-authenticated SSH sessions.
    Add-Type -AssemblyName System.Security
    $stored = Get-Content -LiteralPath $credentialPath -Raw | ConvertFrom-Json
    $bytes = [Security.Cryptography.ProtectedData]::Unprotect([Convert]::FromBase64String([string]$stored.password),
      $null, [Security.Cryptography.DataProtectionScope]::LocalMachine)
    $secure = New-Object Security.SecureString
    foreach ($ch in [Text.Encoding]::UTF8.GetString($bytes).ToCharArray()) { $secure.AppendChar($ch) }
    [Array]::Clear($bytes, 0, $bytes.Length)
    $secure.MakeReadOnly()
    $credential = New-Object Management.Automation.PSCredential ([string]$stored.user, $secure)
  } else {
    $credential = Import-Clixml -LiteralPath $credentialPath
  }
  if ($credential -isnot [Management.Automation.PSCredential]) { throw '-CredentialFile must contain an exported PSCredential.' }
  $networkCredential = $credential.GetNetworkCredential()
  if ($networkCredential.Domain -and $networkCredential.Domain -ne '.' -and
      $networkCredential.Domain -ne [Environment]::MachineName) { throw 'Only a local account is supported.' }
  $localName = $networkCredential.UserName
  $accounts = @(Get-CimInstance Win32_UserAccount -Filter 'LocalAccount = TRUE' |
    Where-Object { $_.Name -eq $localName })
  if ($accounts.Count -ne 1 -or $accounts[0].Disabled) { throw 'Credential does not identify an enabled local account.' }
  $account = $accounts[0]
  $accountName = "$($account.Domain)\$($account.Name)"
  $adminGroup = Get-CimInstance Win32_Group -Filter "LocalAccount = TRUE AND SID = 'S-1-5-32-544'"
  if (-not $adminGroup) { throw 'Cannot resolve the local Administrators group by SID.' }
  if ([string]::IsNullOrWhiteSpace($Command)) { throw '-Command is required.' }
  $application = Get-Command -Name $Command -CommandType Application -ErrorAction Stop | Select-Object -First 1
  $commandPath = Get-AcceptancePath $application.Source
  if ([IO.Path]::GetExtension($commandPath) -notin @('.exe', '.com')) { throw '-Command must be an executable; pass a shell explicitly for scripts.' }
  if (-not $WorkingDirectory) { $WorkingDirectory = Split-Path -Parent $commandPath }
  $workingPath = Get-AcceptancePath $WorkingDirectory
  if (-not (Test-Path -LiteralPath $workingPath -PathType Container)) { throw '-WorkingDirectory must exist.' }
  $dir = Initialize-AcceptanceEvidence $dir
  $env:TEMP = $dir
  $env:TMP = $dir
  if (-not ('TivanoAcceptance.LocalGroups' -as [type])) {
    # LG_INCLUDE_INDIRECT includes indirect membership; group names are compared to the SID-resolved group.
    # https://learn.microsoft.com/en-us/windows/win32/api/lmaccess/nf-lmaccess-netusergetlocalgroups
    Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
namespace TivanoAcceptance {
  public static class LocalGroups {
    [DllImport("netapi32.dll", CharSet = CharSet.Unicode)]
    static extern int NetUserGetLocalGroups(string server, string user, int level, int flags,
      out IntPtr buffer, int preferredLength, out int read, out int total);
    [DllImport("netapi32.dll")] static extern int NetApiBufferFree(IntPtr buffer);
    public static string[] ForUser(string user) {
      IntPtr buffer = IntPtr.Zero;
      try {
        int read, total;
        int code = NetUserGetLocalGroups(null, user, 0, 1, out buffer, -1, out read, out total);
        if (code != 0) throw new Win32Exception(code);
        if (read != total) throw new InvalidOperationException("Incomplete group membership result.");
        var groups = new string[read];
        for (int i = 0; i < read; i++) groups[i] = Marshal.PtrToStringUni(Marshal.ReadIntPtr(buffer, i * IntPtr.Size));
        return groups;
      } finally { if (buffer != IntPtr.Zero) NetApiBufferFree(buffer); }
    }
  }
}
'@
  }
  if ([TivanoAcceptance.LocalGroups]::ForUser($localName) -contains $adminGroup.Name) {
    throw 'The credential account belongs to local Administrators; a separate standard account is required.'
  }
  $acl = Start-Process -FilePath (Join-Path ([Environment]::GetFolderPath('System')) 'icacls.exe') `
    -ArgumentList ('"' + $dir + '" /grant "*' + $account.SID + ':(OI)(CI)M"') `
    -RedirectStandardOutput (Join-Path $dir 'acl.out.log') -RedirectStandardError (Join-Path $dir 'acl.err.log') `
    -Wait -PassThru -WindowStyle Hidden
  if ($acl.ExitCode -ne 0) { throw 'Cannot grant the standard account Modify on the evidence directory; see acl.err.log.' }
  $config = @{
    command = $commandPath; arguments = @($Arguments); workingDirectory = $workingPath
    evidence = $dir; sid = $account.SID
  } | ConvertTo-Json -Compress
  $encoded = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($config))
  $runner = '$config = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String(' +
    (ConvertTo-AcceptanceLiteral $encoded) + ')) | ConvertFrom-Json' + "`r`n" + @'
$ErrorActionPreference = 'Stop'
try {
  $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
  if ($identity.User.Value -ne $config.sid -or
      @($identity.Groups | ForEach-Object { $_.Value }) -contains 'S-1-5-32-544') {
    throw 'Task token is not the requested standard account.'
  }
  $env:TEMP = $config.evidence
  $env:TMP = $config.evidence
  # Quote argv for the Windows C runtime, without sending caller arguments through cmd.exe.
  function Quote-Argument([AllowEmptyString()][string]$value) {
    return '"' + ([regex]::Replace(([regex]::Replace($value, '(\\*)"', '$1$1\"')), '(\\+)$', '$1$1')) + '"'
  }
  $start = New-Object Diagnostics.ProcessStartInfo
  $start.FileName = $config.command
  $start.Arguments = (@($config.arguments | ForEach-Object { Quote-Argument $_ }) -join ' ')
  $start.WorkingDirectory = $config.workingDirectory
  $start.UseShellExecute = $false
  $start.CreateNoWindow = $true
  # Without redirection a windowless child writes to its own hidden console and the output is lost.
  $start.RedirectStandardOutput = $true
  $start.RedirectStandardError = $true
  $process = [Diagnostics.Process]::Start($start)
  try {
    $stdout = $process.StandardOutput.ReadToEndAsync()
    $stderr = $process.StandardError.ReadToEndAsync()
    $process.WaitForExit()
    [Console]::Out.Write($stdout.Result)
    [Console]::Error.Write($stderr.Result)
    $result = $process.ExitCode
  }
  finally { $process.Dispose() }
  exit $result
} catch {
  [Console]::Error.WriteLine($_.Exception.Message)
  exit 1
}
'@
  $header = "# Tivano Windows - derived from Tivano (AGPL-3.0), modified 2026-11-07.`r`n# Droppy Code by Jordy Spruit (Droppy), https://getdroppycode.app`r`n"
  Set-Content -LiteralPath (Join-Path $dir 'standard-command.ps1') -Value ($header + $runner) -Encoding UTF8
  $wrapperPath = Join-Path $dir 'standard-command.cmd'
  $wrapper = @'
@echo off
setlocal DisableDelayedExpansion
"%SystemRoot%\System32\whoami.exe" /groups > "%~dp0whoami.txt" 2> "%~dp0whoami.err.log"
if errorlevel 1 exit /b 1
"%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "%~dp0standard-command.ps1" > "%~dp0standard.out.log" 2> "%~dp0standard.err.log"
set "result=%errorlevel%"
> "%~dp0standard.exit.txt" echo %result%
exit /b %result%
'@
  [IO.File]::WriteAllText($wrapperPath, ($wrapper -replace '\r?\n', "`r`n"), [Text.Encoding]::ASCII)
  Initialize-AcceptanceTaskFolder
  $taskName = 'standard-' + [Guid]::NewGuid().ToString('N')
  $action = New-ScheduledTaskAction -Execute (Join-Path ([Environment]::GetFolderPath('System')) 'cmd.exe') `
    -Argument ('/d /v:off /s /c ""' + $wrapperPath + '""') -WorkingDirectory $dir
  $principal = New-ScheduledTaskPrincipal -UserId $accountName -LogonType Password -RunLevel Limited
  $settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
    -ExecutionTimeLimit (New-TimeSpan -Seconds $TimeoutSec)
  $task = New-ScheduledTask -Action $action -Principal $principal -Settings $settings
  try {
    $plainPassword = $credential.GetNetworkCredential().Password
    Register-ScheduledTask -TaskName $taskName -TaskPath '\TivanoAcceptance\' -InputObject $task `
      -User $accountName -Password $plainPassword | Out-Null
    $registered = $true
  } finally {
    $plainPassword = $null
    $networkCredential = $null
    $credential = $null
  }
  Start-ScheduledTask -TaskName $taskName -TaskPath '\TivanoAcceptance\'
  $exitCode = Wait-AcceptanceTask -TaskName $taskName -TimeoutSec $TimeoutSec
  $completed = $true
  if ($exitCode -eq 0 -and -not (Test-Path -LiteralPath (Join-Path $dir 'standard.exit.txt'))) {
    throw 'Task returned success without command completion evidence.'
  }
  $summary = [ordered]@{
    ok = ($exitCode -eq 0); exitCode = $exitCode; accountSid = $account.SID
    stdoutPath = (Join-Path $dir 'standard.out.log'); stderrPath = (Join-Path $dir 'standard.err.log')
    groupsPath = (Join-Path $dir 'whoami.txt')
  }
  if ($exitCode -eq 0) { $status = 0 }
} catch {
  $summary = [ordered]@{ ok = $false; exitCode = 1; error = $_.Exception.Message }
} finally {
  try {
    if ($registered) {
      try {
        if (-not $completed) { Stop-ScheduledTask -TaskName $taskName -TaskPath '\TivanoAcceptance\' }
      } finally {
        Unregister-ScheduledTask -TaskName $taskName -TaskPath '\TivanoAcceptance\' -Confirm:$false
      }
    }
  } catch {
    $summary = [ordered]@{ ok = $false; exitCode = 1; error = 'Scheduled-task cleanup failed.'; taskName = $taskName }
    $status = 1
  } finally {
    $plainPassword = $null
    $networkCredential = $null
    $credential = $null
    $env:TEMP = $oldTemp
    $env:TMP = $oldTmp
  }
}
Write-AcceptanceSummary $summary
exit $status
