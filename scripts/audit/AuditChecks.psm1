# Tivano Windows - derived from Tivano (AGPL-3.0), modified 2026-11-23.
# Droppy Code by Jordy Spruit (Droppy), https://getdroppycode.app
# Shared configuration, GitHub App token, GitHub REST API, and audit model helpers (GLM-5.4 via ZCode with Gemini 4 Neon fallback via agy) for Nyx PR and post-merge audits.

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

try {
  [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
} catch { }

$script:ModuleDir = $PSScriptRoot
$script:TokenCache = @{}
$script:CmdExe = Join-Path ([Environment]::GetFolderPath('System')) 'cmd.exe'
$script:TaskkillExe = Join-Path ([Environment]::GetFolderPath('System')) 'taskkill.exe'
$script:DefaultDevinCli = 'C:\Users\elijah\AppData\Local\Programs\Devin\resources\app\extensions\windsurf\devin\bin\devin.exe'
$script:DefaultArbiterModel = 'claude-opus-5-5-xhigh'
$script:DefaultAgyCli = 'C:\Users\elijah\AppData\Local\agy\bin\agy.exe'
$script:DefaultFallbackModel = 'gemini-4-neon-high'

function Write-AuditText {
  param(
    [string]$Path,
    [AllowEmptyString()][string]$Text
  )
  [IO.File]::WriteAllText($Path, $Text, (New-Object Text.UTF8Encoding($false)))
}

function Read-AuditText {
  param([string]$Path)
  if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { return $null }
  return [IO.File]::ReadAllText($Path, [Text.Encoding]::UTF8)
}

function Quote-AuditArg {
  param([AllowEmptyString()][string]$Value)
  return '"' + $Value + '"'
}

function Get-AuditProp {
  param(
    $Object,
    [string]$Name
  )
  if ($null -eq $Object) { return $null }
  if ($Object -is [Collections.IDictionary]) {
    if ($Object.Contains($Name)) { return $Object[$Name] }
    return $null
  }
  $prop = $Object.PSObject.Properties[$Name]
  if ($null -ne $prop) { return $prop.Value }
  return $null
}

function Test-AuditHasProp {
  param(
    $Object,
    [string]$Name
  )
  if ($null -eq $Object) { return $false }
  if ($Object -is [Collections.IDictionary]) {
    return $Object.Contains($Name)
  }
  return ($null -ne $Object.PSObject.Properties[$Name])
}

function ConvertTo-AuditSingleLine {
  param(
    [AllowEmptyString()][string]$Text,
    [int]$Limit = 300
  )
  if ($null -eq $Text) { return '' }
  $line = [regex]::Replace($Text, '[\x00-\x1f\x7f]+', ' ')
  $line = [regex]::Replace($line, '\s+', ' ').Trim()
  $line = $line.Replace('"', "'").TrimEnd('\')
  if ($line.Length -gt $Limit) { $line = $line.Substring(0, $Limit).Trim() }
  return $line
}

function Get-AuditTail {
  param(
    [string]$Path,
    [int]$Count
  )
  if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { return $null }
  $text = Read-AuditText $Path
  if ([string]::IsNullOrWhiteSpace($text)) { return '' }
  $lines = @($text.TrimEnd() -split "`r?`n")
  if ($lines.Count -le $Count) { return ($lines -join "`n") }
  return (($lines[($lines.Count - $Count)..($lines.Count - 1)]) -join "`n")
}

function Assert-AuditCmdSafePath {
  param(
    [string]$Name,
    [string]$Path
  )
  if ($Path.Contains('%') -or $Path.Contains('"') -or $Path.Contains("`r") -or $Path.Contains("`n")) {
    throw ($Name + ' cannot contain percent signs, quotes or newlines.')
  }
}

function Invoke-AuditTool {
  param(
    [string]$FilePath,
    [string]$Arguments,
    [string]$OutPath,
    [string]$ErrPath,
    [string]$WorkingDirectory = ''
  )
  $parameters = @{
    FilePath = $FilePath
    ArgumentList = $Arguments
    RedirectStandardOutput = $OutPath
    RedirectStandardError = $ErrPath
    WindowStyle = 'Hidden'
    Wait = $true
    PassThru = $true
  }
  if (-not [string]::IsNullOrWhiteSpace($WorkingDirectory)) {
    $parameters['WorkingDirectory'] = $WorkingDirectory
  }
  $process = Start-Process @parameters
  return $process.ExitCode
}

function Stop-AuditTreeProcesses {
  param([string]$WorkDir)
  if ([string]::IsNullOrWhiteSpace($WorkDir)) { return }
  try {
    $all = @(Get-CimInstance Win32_Process -ErrorAction SilentlyContinue)
    $keep = @{}
    $id = $PID
    while ($id -and -not $keep.ContainsKey($id)) {
      $keep[$id] = $true
      $proc = $all | Where-Object { $_.ProcessId -eq $id } | Select-Object -First 1
      if ($proc) { $id = $proc.ParentProcessId } else { $id = 0 }
    }
    foreach ($proc in $all) {
      if ($keep.ContainsKey($proc.ProcessId)) { continue }
      $exeHit = $proc.ExecutablePath -and $proc.ExecutablePath.StartsWith($WorkDir, [StringComparison]::OrdinalIgnoreCase)
      $cmdHit = $proc.CommandLine -and $proc.CommandLine.IndexOf($WorkDir, [StringComparison]::OrdinalIgnoreCase) -ge 0
      if ($exeHit -or $cmdHit) {
        Stop-Process -Id $proc.ProcessId -Force -ErrorAction SilentlyContinue
      }
    }
  } catch { }
}

function Resolve-AuditNodePath {
  param($Config)
  $zcodeCfg = Get-AuditProp $Config 'zcode'
  $candidates = New-Object Collections.Generic.List[string]
  if ($null -ne $zcodeCfg -and $zcodeCfg -isnot [string]) {
    foreach ($key in @('nodePath', 'node', 'nodeExe')) {
      $val = Get-AuditProp $zcodeCfg $key
      if ($null -ne $val -and -not [string]::IsNullOrWhiteSpace([string]$val)) {
        $null = $candidates.Add(([string]$val).Trim())
      }
    }
  }
  $topNode = Get-AuditProp $Config 'nodePath'
  if ($null -ne $topNode -and -not [string]::IsNullOrWhiteSpace([string]$topNode)) {
    $null = $candidates.Add(([string]$topNode).Trim())
  }
  $null = $candidates.Add('C:\Program Files\nodejs\node.exe')
  foreach ($candidate in $candidates) {
    if (Test-Path -LiteralPath $candidate -PathType Leaf) { return $candidate }
  }
  $cmd = Get-Command -Name 'node' -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($cmd -and $cmd.Source) { return $cmd.Source }
  throw 'node.exe was not found.'
}

function Resolve-AuditZCodeSettings {
  param($Config)
  $zcodeCfg = Get-AuditProp $Config 'zcode'
  $scriptPath = 'C:\tivano\zcode\zcode.cjs'
  $dataBaseDir = 'C:\tivano\zcode\home'
  $sourcePath = 'C:\Program Files\ZCode\resources\glm\zcode.cjs'
  $builtinSourcePath = 'C:\Program Files\ZCode\resources\config\provider\zcode-builtin.json'
  $providerDir = 'C:\tivano\zcode\provider'
  $providerExplicit = $false

  if ($zcodeCfg -is [string]) {
    $scriptPath = $zcodeCfg.Trim()
  } elseif ($null -ne $zcodeCfg) {
    foreach ($key in @('zcodePath', 'path', 'script', 'scriptPath', 'bundle', 'cliPath', 'entrypoint')) {
      $val = Get-AuditProp $zcodeCfg $key
      if ($null -ne $val -and -not [string]::IsNullOrWhiteSpace([string]$val)) {
        $scriptPath = ([string]$val).Trim()
        break
      }
    }
    foreach ($key in @('dataBaseDir', 'zcodeDataBaseDir', 'dataDir', 'home', 'homeDir')) {
      $val = Get-AuditProp $zcodeCfg $key
      if ($null -ne $val -and -not [string]::IsNullOrWhiteSpace([string]$val)) {
        $dataBaseDir = ([string]$val).Trim()
        break
      }
    }
    foreach ($key in @('sourcePath', 'zcodeSourcePath', 'sourceBundle')) {
      $val = Get-AuditProp $zcodeCfg $key
      if ($null -ne $val -and -not [string]::IsNullOrWhiteSpace([string]$val)) {
        $sourcePath = ([string]$val).Trim()
        break
      }
    }
    foreach ($key in @('builtinSourcePath', 'zcodeBuiltinSourcePath', 'sourceBuiltin')) {
      $val = Get-AuditProp $zcodeCfg $key
      if ($null -ne $val -and -not [string]::IsNullOrWhiteSpace([string]$val)) {
        $builtinSourcePath = ([string]$val).Trim()
        break
      }
    }
    foreach ($key in @('providerDir', 'zcodeProviderDir')) {
      $val = Get-AuditProp $zcodeCfg $key
      if ($null -ne $val -and -not [string]::IsNullOrWhiteSpace([string]$val)) {
        $providerDir = ([string]$val).Trim()
        $providerExplicit = $true
        break
      }
    }
  }

  $topData = Get-AuditProp $Config 'zcodeDataBaseDir'
  if ($null -ne $topData -and -not [string]::IsNullOrWhiteSpace([string]$topData)) { $dataBaseDir = ([string]$topData).Trim() }
  $topSource = Get-AuditProp $Config 'zcodeSourcePath'
  if ($null -ne $topSource -and -not [string]::IsNullOrWhiteSpace([string]$topSource)) { $sourcePath = ([string]$topSource).Trim() }
  $topBuiltin = Get-AuditProp $Config 'zcodeBuiltinSourcePath'
  if ($null -ne $topBuiltin -and -not [string]::IsNullOrWhiteSpace([string]$topBuiltin)) { $builtinSourcePath = ([string]$topBuiltin).Trim() }
  $topProvider = Get-AuditProp $Config 'zcodeProviderDir'
  if ($null -ne $topProvider -and -not [string]::IsNullOrWhiteSpace([string]$topProvider)) {
    $providerDir = ([string]$topProvider).Trim()
    $providerExplicit = $true
  }

  return [pscustomobject]@{
    nodePath = (Resolve-AuditNodePath $Config)
    scriptPath = $scriptPath
    dataBaseDir = $dataBaseDir
    sourcePath = $sourcePath
    builtinSourcePath = $builtinSourcePath
    providerDir = $providerDir
    providerExplicit = $providerExplicit
  }
}

function Sync-AuditZCodeBundle {
  param(
    [string]$SourceBundle,
    [string]$TargetBundle,
    [string]$SourceBuiltin,
    [string]$TargetProviderDir,
    [bool]$RequireBuiltin = $false
  )
  $targetBuiltin = Join-Path $TargetProviderDir 'zcode-builtin.json'
  if (-not [string]::IsNullOrWhiteSpace($SourceBundle) -and (Test-Path -LiteralPath $SourceBundle -PathType Leaf)) {
    $srcItem = Get-Item -LiteralPath $SourceBundle
    $needCopy = -not (Test-Path -LiteralPath $TargetBundle -PathType Leaf)
    if (-not $needCopy) {
      $dstItem = Get-Item -LiteralPath $TargetBundle
      if ($srcItem.LastWriteTimeUtc -gt $dstItem.LastWriteTimeUtc) {
        $needCopy = $true
      }
    }
    if ($needCopy) {
      [IO.Directory]::CreateDirectory((Split-Path -Parent $TargetBundle)) | Out-Null
      Copy-Item -LiteralPath $SourceBundle -Destination $TargetBundle -Force
      if (-not [string]::IsNullOrWhiteSpace($SourceBuiltin) -and (Test-Path -LiteralPath $SourceBuiltin -PathType Leaf)) {
        [IO.Directory]::CreateDirectory($TargetProviderDir) | Out-Null
        Copy-Item -LiteralPath $SourceBuiltin -Destination $targetBuiltin -Force
      }
    }
  }
  if (-not (Test-Path -LiteralPath $targetBuiltin -PathType Leaf) -and
      -not [string]::IsNullOrWhiteSpace($SourceBuiltin) -and
      (Test-Path -LiteralPath $SourceBuiltin -PathType Leaf)) {
    [IO.Directory]::CreateDirectory($TargetProviderDir) | Out-Null
    Copy-Item -LiteralPath $SourceBuiltin -Destination $targetBuiltin -Force
  }
  if (-not (Test-Path -LiteralPath $TargetBundle -PathType Leaf)) {
    throw ('ZCode bundle not found at ' + $TargetBundle)
  }
  if (($RequireBuiltin -or (-not [string]::IsNullOrWhiteSpace($SourceBuiltin) -and (Test-Path -LiteralPath $SourceBuiltin -PathType Leaf))) -and
      -not (Test-Path -LiteralPath $targetBuiltin -PathType Leaf)) {
    throw ('ZCode built-in provider config not found at ' + $targetBuiltin)
  }
}

function Parse-AuditLastJsonObject {
  param([string]$Text)
  if ([string]::IsNullOrWhiteSpace($Text)) { return $null }
  $lines = @($Text -split "`r?`n")
  $end = $lines.Count - 1
  while ($end -ge 0 -and [string]::IsNullOrWhiteSpace($lines[$end])) { $end-- }
  if ($end -lt 0) { return $null }

  $hadClosingFence = $false
  if ($lines[$end].Trim() -eq '```') {
    $hadClosingFence = $true
    $end--
    while ($end -ge 0 -and [string]::IsNullOrWhiteSpace($lines[$end])) { $end-- }
  }
  if ($end -lt 0) { return $null }

  $candidate = $lines[$end].Trim()
  if ($candidate.StartsWith('{')) {
    try {
      $parsed = $candidate | ConvertFrom-Json
      if ($parsed -is [pscustomobject]) { return $parsed }
    } catch { }
  }

  if ($hadClosingFence) {
    $start = $end
    while ($start -ge 0 -and $lines[$start].Trim() -notmatch '^```(?:json)?\s*$') { $start-- }
    if ($start -ge 0 -and $start -lt $end) {
      $block = ($lines[($start + 1)..$end] -join "`n").Trim()
      if ($block.StartsWith('{')) {
        try {
          $parsed = $block | ConvertFrom-Json
          if ($parsed -is [pscustomobject]) { return $parsed }
        } catch { }
      }
    }
  }
  return $null
}

function Get-UniqueRunFilePath {
  param(
    [string]$RunDir,
    [string]$BaseName,
    [string]$Extension
  )
  $candidate = Join-Path $RunDir ($BaseName + $Extension)
  if (-not (Test-Path -LiteralPath $candidate)) { return $candidate }
  for ($i = 2; $i -le 999; $i++) {
    $next = Join-Path $RunDir ($BaseName + '-' + $i + $Extension)
    if (-not (Test-Path -LiteralPath $next)) { return $next }
  }
  return (Join-Path $RunDir ($BaseName + '-' + [Guid]::NewGuid().ToString('N').Substring(0, 6) + $Extension))
}

function Get-AuditConfig {
  param(
    [Parameter(Mandatory = $true)]
    [string]$Path
  )
  if ([string]::IsNullOrWhiteSpace($Path)) {
    throw 'Config path is required.'
  }
  if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
    throw ('Audit config file not found: ' + $Path)
  }
  $text = Read-AuditText $Path
  if ([string]::IsNullOrWhiteSpace($text)) {
    throw ('Audit config file is empty: ' + $Path)
  }
  $raw = $null
  try {
    $raw = $text.TrimStart([char]0xFEFF) | ConvertFrom-Json
  } catch {
    throw ('Audit config file is not valid JSON: ' + $_.Exception.Message)
  }
  if ($raw -isnot [pscustomobject]) {
    throw 'Audit config JSON root must be an object.'
  }

  $required = @('repo', 'appId', 'installationId', 'keyPath', 'zcode', 'model', 'referenceRoot', 'workRoot')
  foreach ($key in $required) {
    if (-not (Test-AuditHasProp $raw $key)) {
      throw ('Audit config is missing required key: ' + $key)
    }
    $value = Get-AuditProp $raw $key
    if ($null -eq $value) {
      throw ('Audit config key must not be null: ' + $key)
    }
    if ($key -eq 'zcode') {
      if ($value -is [string]) {
        if ([string]::IsNullOrWhiteSpace($value)) {
          throw 'Audit config key zcode must not be empty.'
        }
      } elseif ($value -is [pscustomobject]) {
        if (@($value.PSObject.Properties).Count -eq 0) {
          throw 'Audit config key zcode object must not be empty.'
        }
      } else {
        throw 'Audit config key zcode must be a path string or configuration object.'
      }
    } else {
      if ([string]::IsNullOrWhiteSpace([string]$value)) {
        throw ('Audit config key must not be empty: ' + $key)
      }
    }
  }

  $repo = ([string](Get-AuditProp $raw 'repo')).Trim()
  if ($repo -notmatch '^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$') {
    throw ('Audit config repo must be owner/name, got: ' + $repo)
  }

  $statusContext = 'nyx/audit'
  if (Test-AuditHasProp $raw 'statusContext') {
    $rawContext = Get-AuditProp $raw 'statusContext'
    if ($null -ne $rawContext -and -not [string]::IsNullOrWhiteSpace([string]$rawContext)) {
      $statusContext = ([string]$rawContext).Trim()
    }
  }

  $timeoutMinutes = 30
  if (Test-AuditHasProp $raw 'timeoutMinutes') {
    $rawTimeout = Get-AuditProp $raw 'timeoutMinutes'
    if ($null -ne $rawTimeout -and -not [string]::IsNullOrWhiteSpace([string]$rawTimeout)) {
      $parsedTimeout = 0
      if (-not [int]::TryParse([string]$rawTimeout, [ref]$parsedTimeout) -or $parsedTimeout -le 0) {
        throw ('Audit config timeoutMinutes must be a positive integer, got: ' + [string]$rawTimeout)
      }
      $timeoutMinutes = $parsedTimeout
    }
  }

  $devinCli = $script:DefaultDevinCli
  if (Test-AuditHasProp $raw 'devinCli') {
    $rawDevinCli = Get-AuditProp $raw 'devinCli'
    if ($null -ne $rawDevinCli -and -not [string]::IsNullOrWhiteSpace([string]$rawDevinCli)) {
      $devinCli = ([string]$rawDevinCli).Trim()
    }
  }

  $arbiterModel = $script:DefaultArbiterModel
  if (Test-AuditHasProp $raw 'arbiterModel') {
    $rawArbiterModel = Get-AuditProp $raw 'arbiterModel'
    if ($null -ne $rawArbiterModel -and -not [string]::IsNullOrWhiteSpace([string]$rawArbiterModel)) {
      $arbiterModel = ([string]$rawArbiterModel).Trim()
    }
  }

  $arbiterTimeoutMinutes = 30
  if (Test-AuditHasProp $raw 'arbiterTimeoutMinutes') {
    $rawArbiterTimeout = Get-AuditProp $raw 'arbiterTimeoutMinutes'
    if ($null -ne $rawArbiterTimeout -and -not [string]::IsNullOrWhiteSpace([string]$rawArbiterTimeout)) {
      $parsedArbiterTimeout = 0
      if (-not [int]::TryParse([string]$rawArbiterTimeout, [ref]$parsedArbiterTimeout) -or $parsedArbiterTimeout -le 0) {
        throw ('Audit config arbiterTimeoutMinutes must be a positive integer, got: ' + [string]$rawArbiterTimeout)
      }
      $arbiterTimeoutMinutes = $parsedArbiterTimeout
    }
  }

  $arbiterDailyCap = 6
  if (Test-AuditHasProp $raw 'arbiterDailyCap') {
    $rawDailyCap = Get-AuditProp $raw 'arbiterDailyCap'
    if ($null -ne $rawDailyCap -and -not [string]::IsNullOrWhiteSpace([string]$rawDailyCap)) {
      $parsedDailyCap = 0
      if (-not [int]::TryParse([string]$rawDailyCap, [ref]$parsedDailyCap) -or $parsedDailyCap -lt 0) {
        throw ('Audit config arbiterDailyCap must be a non-negative integer, got: ' + [string]$rawDailyCap)
      }
      $arbiterDailyCap = $parsedDailyCap
    }
  }

  $agyPath = ''
  if (Test-AuditHasProp $raw 'agyPath') {
    $rawAgyPath = Get-AuditProp $raw 'agyPath'
    if ($null -ne $rawAgyPath -and -not [string]::IsNullOrWhiteSpace([string]$rawAgyPath)) {
      $agyPath = ([string]$rawAgyPath).Trim()
    }
  }

  $fallbackModel = $script:DefaultFallbackModel
  if (Test-AuditHasProp $raw 'fallbackModel') {
    $rawFallbackModel = Get-AuditProp $raw 'fallbackModel'
    if ($null -ne $rawFallbackModel -and -not [string]::IsNullOrWhiteSpace([string]$rawFallbackModel)) {
      $fallbackModel = ([string]$rawFallbackModel).Trim()
    }
  }

  $out = [ordered]@{}
  foreach ($prop in $raw.PSObject.Properties) {
    $out[$prop.Name] = $prop.Value
  }
  $out['repo'] = $repo
  $out['appId'] = ([string](Get-AuditProp $raw 'appId')).Trim()
  $out['installationId'] = ([string](Get-AuditProp $raw 'installationId')).Trim()
  $out['keyPath'] = ([string](Get-AuditProp $raw 'keyPath')).Trim()
  $out['zcode'] = Get-AuditProp $raw 'zcode'
  $out['model'] = ([string](Get-AuditProp $raw 'model')).Trim()
  $out['agyPath'] = $agyPath
  $out['fallbackModel'] = $fallbackModel
  $out['devinCli'] = $devinCli
  $out['arbiterModel'] = $arbiterModel
  $out['arbiterTimeoutMinutes'] = $arbiterTimeoutMinutes
  $out['arbiterDailyCap'] = $arbiterDailyCap
  $out['referenceRoot'] = ([string](Get-AuditProp $raw 'referenceRoot')).Trim()
  $out['workRoot'] = ([string](Get-AuditProp $raw 'workRoot')).Trim()
  $out['statusContext'] = $statusContext
  $out['timeoutMinutes'] = $timeoutMinutes

  return [pscustomobject]$out
}

function Get-AuditToken {
  param(
    [Parameter(Mandatory = $true)]
    $Config
  )
  $appId = [string](Get-AuditProp $Config 'appId')
  $installationId = [string](Get-AuditProp $Config 'installationId')
  $keyPath = [string](Get-AuditProp $Config 'keyPath')
  if ([string]::IsNullOrWhiteSpace($appId) -or
      [string]::IsNullOrWhiteSpace($installationId) -or
      [string]::IsNullOrWhiteSpace($keyPath)) {
    throw 'Config must include appId, installationId and keyPath.'
  }

  $cacheKey = $appId.Trim() + '|' + $installationId.Trim() + '|' + $keyPath.Trim()
  if ($script:TokenCache.ContainsKey($cacheKey)) {
    $cached = $script:TokenCache[$cacheKey]
    if ([DateTime]::UtcNow -lt $cached.expiresUtc -and -not [string]::IsNullOrWhiteSpace($cached.token)) {
      return $cached.token
    }
  }

  $mintScript = Join-Path $script:ModuleDir 'mint-token.mjs'
  if (-not (Test-Path -LiteralPath $mintScript -PathType Leaf)) {
    throw ('mint-token.mjs not found at ' + $mintScript)
  }
  $nodeExe = Resolve-AuditNodePath $Config

  $argLine = (Quote-AuditArg $mintScript) +
    ' --app-id ' + (Quote-AuditArg $appId.Trim()) +
    ' --installation-id ' + (Quote-AuditArg $installationId.Trim()) +
    ' --key ' + (Quote-AuditArg $keyPath.Trim())

  $psi = New-Object Diagnostics.ProcessStartInfo
  $psi.FileName = $nodeExe
  $psi.Arguments = $argLine
  $psi.UseShellExecute = $false
  $psi.CreateNoWindow = $true
  $psi.RedirectStandardOutput = $true
  $psi.RedirectStandardError = $true
  $psi.StandardOutputEncoding = [Text.Encoding]::UTF8
  $psi.StandardErrorEncoding = [Text.Encoding]::UTF8

  $proc = New-Object Diagnostics.Process
  $proc.StartInfo = $psi
  try {
    $null = $proc.Start()
    $stdoutTask = $proc.StandardOutput.ReadToEndAsync()
    $stderrTask = $proc.StandardError.ReadToEndAsync()
    if (-not $proc.WaitForExit(60000)) {
      try { $proc.Kill() } catch { }
      throw 'mint-token.mjs timed out after 60 seconds.'
    }
    $proc.WaitForExit()
    $stdout = $stdoutTask.GetAwaiter().GetResult()
    $stderr = $stderrTask.GetAwaiter().GetResult()
    $code = $proc.ExitCode
  } finally {
    $proc.Dispose()
  }

  if ($code -ne 0) {
    $errSummary = ConvertTo-AuditSingleLine ([string]$stderr) 240
    throw ('mint-token.mjs exited with code ' + $code + $(if ($errSummary) { ': ' + $errSummary } else { '' }))
  }
  $token = if ($null -ne $stdout) { $stdout.Trim() } else { '' }
  if ([string]::IsNullOrWhiteSpace($token)) {
    throw 'mint-token.mjs produced an empty token.'
  }

  $script:TokenCache[$cacheKey] = @{
    token = $token
    expiresUtc = [DateTime]::UtcNow.AddMinutes(45)
  }
  return $token
}

function Invoke-AuditApi {
  param(
    [Parameter(Mandatory = $true)]
    $Config,
    [Parameter(Mandatory = $true)]
    [string]$Method,
    [Parameter(Mandatory = $true)]
    [string]$Path,
    $Body = $null
  )
  if ([string]::IsNullOrWhiteSpace($Method)) { throw 'HTTP method is required.' }
  if ([string]::IsNullOrWhiteSpace($Path)) { throw 'API path is required.' }

  $trimmedPath = $Path.Trim()
  if ($trimmedPath.StartsWith('https://api.github.com/', [StringComparison]::OrdinalIgnoreCase)) {
    $uri = $trimmedPath
  } elseif ($trimmedPath.StartsWith('/')) {
    $uri = 'https://api.github.com' + $trimmedPath
  } elseif ($trimmedPath -match '^[A-Za-z][A-Za-z0-9+.-]*://') {
    throw 'Invoke-AuditApi only allows paths against https://api.github.com.'
  } else {
    $uri = 'https://api.github.com/' + $trimmedPath
  }

  $token = Get-AuditToken -Config $Config
  $headers = @{
    Authorization = 'Bearer ' + $token
    Accept = 'application/vnd.github+json'
    'X-GitHub-Api-Version' = '2022-11-28'
    'User-Agent' = 'tivano-windows-nyx-audit'
  }

  $bodyBytes = $null
  if ($null -ne $Body) {
    $jsonText = if ($Body -is [string]) { $Body } else { ConvertTo-Json -InputObject $Body -Depth 10 -Compress }
    $bodyBytes = [Text.Encoding]::UTF8.GetBytes($jsonText)
  }

  for ($attempt = 1; $attempt -le 2; $attempt++) {
    try {
      $params = @{
        Method = $Method.Trim().ToUpperInvariant()
        Uri = $uri
        Headers = $headers
        ErrorAction = 'Stop'
      }
      if ($null -ne $bodyBytes) {
        $params['Body'] = $bodyBytes
        $params['ContentType'] = 'application/json; charset=utf-8'
      }
      return (Invoke-RestMethod @params)
    } catch {
      $ex = $_.Exception
      $statusCode = $null
      $respBody = ''
      if ($null -ne $ex -and $ex.PSObject.Properties['Response'] -and $null -ne $ex.Response) {
        try { $statusCode = [int]$ex.Response.StatusCode } catch { $statusCode = $null }
        try {
          $stream = $ex.Response.GetResponseStream()
          if ($null -ne $stream) {
            $reader = New-Object IO.StreamReader($stream, [Text.Encoding]::UTF8)
            try { $respBody = $reader.ReadToEnd() } finally { $reader.Dispose() }
          }
        } catch { }
      }

      $is5xx = ($null -ne $statusCode -and $statusCode -ge 500 -and $statusCode -lt 600)
      $exMsg = if ($null -ne $ex) { [string]$ex.Message } else { '' }
      $isNetwork = ($null -eq $statusCode) -and (
        ($ex -is [Net.WebException]) -or
        ($ex -is [IO.IOException]) -or
        ($exMsg -match '(?i)timed out|timeout|unable to connect|could not be resolved|name resolution|connection (was )?(closed|reset|refused)|TLS|SSL|EOF|underlying connection')
      )

      if ($attempt -lt 2 -and ($is5xx -or $isNetwork)) {
        Start-Sleep -Seconds 3
        continue
      }

      $detail = ConvertTo-AuditSingleLine $respBody 240
      $statusText = if ($null -ne $statusCode) { 'HTTP ' + $statusCode } else { 'network error' }
      $msg = 'GitHub API ' + $Method.Trim().ToUpperInvariant() + ' ' + $trimmedPath + ' failed (' + $statusText + '): ' + (ConvertTo-AuditSingleLine $exMsg 200)
      if (-not [string]::IsNullOrWhiteSpace($detail)) {
        $msg += ' - ' + $detail
      }
      throw $msg
    }
  }
}

function Get-AuditCleanDirPath {
  param([string]$Path)
  if ([string]::IsNullOrWhiteSpace($Path)) { return '' }
  $trimmed = $Path.Trim()
  $root = ''
  try { $root = [IO.Path]::GetPathRoot($trimmed) } catch { $root = '' }
  if (-not [string]::IsNullOrWhiteSpace($root) -and $trimmed.Equals($root, [StringComparison]::OrdinalIgnoreCase)) {
    return $trimmed
  }
  return $trimmed.TrimEnd('\')
}

function Resolve-AuditGitPath {
  $cmd = Get-Command -Name 'git' -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($null -ne $cmd -and -not [string]::IsNullOrWhiteSpace($cmd.Source)) {
    return $cmd.Source
  }
  throw 'git was not found on PATH.'
}

function Invoke-AuditGit {
  param(
    [string]$GitPath,
    [string]$WorkDir,
    [string]$Arguments,
    [string]$RunDir
  )
  $tag = [Guid]::NewGuid().ToString('N').Substring(0, 8)
  $outPath = Join-Path $RunDir ('.git-guard-' + $tag + '.out.tmp')
  $errPath = Join-Path $RunDir ('.git-guard-' + $tag + '.err.tmp')
  try {
    $gitArgs = '-C ' + (Quote-AuditArg $WorkDir) + ' ' + $Arguments
    $code = Invoke-AuditTool $GitPath $gitArgs $outPath $errPath $WorkDir
    $outText = Read-AuditText $outPath
    if ($null -eq $outText) { $outText = '' }
    $errText = Read-AuditText $errPath
    if ($null -eq $errText) { $errText = '' }
    return [pscustomobject]@{
      exitCode = $code
      text = $outText
      error = $errText
    }
  } finally {
    try { if (Test-Path -LiteralPath $outPath -PathType Leaf) { [IO.File]::Delete($outPath) } } catch { }
    try { if (Test-Path -LiteralPath $errPath -PathType Leaf) { [IO.File]::Delete($errPath) } } catch { }
  }
}

function Resolve-AuditAgyExecutable {
  param([string]$RequestedPath = '')
  if (-not [string]::IsNullOrWhiteSpace($RequestedPath)) {
    $candidate = $RequestedPath.Trim()
    if (-not (Test-Path -LiteralPath $candidate -PathType Leaf)) {
      throw ('agy.exe not found at ' + $candidate)
    }
    return [IO.Path]::GetFullPath($candidate)
  }
  if (-not [string]::IsNullOrWhiteSpace($env:LOCALAPPDATA)) {
    $localExe = Join-Path $env:LOCALAPPDATA 'agy\bin\agy.exe'
    if (Test-Path -LiteralPath $localExe -PathType Leaf) {
      return [IO.Path]::GetFullPath($localExe)
    }
  }
  if (Test-Path -LiteralPath $script:DefaultAgyCli -PathType Leaf) {
    return [IO.Path]::GetFullPath($script:DefaultAgyCli)
  }
  $cmd = Get-Command -Name 'agy' -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($null -ne $cmd -and -not [string]::IsNullOrWhiteSpace($cmd.Source) -and (Test-Path -LiteralPath $cmd.Source -PathType Leaf)) {
    return [IO.Path]::GetFullPath($cmd.Source)
  }
  throw 'agy.exe not found at %LOCALAPPDATA%\agy\bin\agy.exe, C:\Users\elijah\AppData\Local\agy\bin\agy.exe, or on PATH.'
}

function Parse-AuditAgyError {
  param(
    [AllowEmptyString()][string]$StderrText,
    [AllowEmptyString()][string]$StdoutText = ''
  )
  $sources = @($StderrText, $StdoutText)
  $matchedJson = $null
  $matchedRaw = $null
  foreach ($src in $sources) {
    if ([string]::IsNullOrWhiteSpace($src)) { continue }
    $lines = @($src -split "`r?`n")
    foreach ($line in $lines) {
      $cleanLine = [regex]::Replace($line, '\x1b\[[0-9;]*[A-Za-z]', '')
      if ($cleanLine -match '^\s*AGY_ERROR:\s*(\{.*\})\s*$') {
        $matchedJson = $Matches[1]
      } elseif ($cleanLine -match '^\s*AGY_ERROR\b') {
        $matchedRaw = $cleanLine.Trim()
      }
    }
    if ($null -ne $matchedJson -or $null -ne $matchedRaw) { break }
  }
  if ($null -eq $matchedJson -and $null -eq $matchedRaw) { return $null }
  if ($null -eq $matchedJson) {
    return [pscustomobject]@{
      message = (ConvertTo-AuditSingleLine $matchedRaw 300)
      errorCode = ''
    }
  }

  $parsed = $null
  try {
    $parsed = $matchedJson | ConvertFrom-Json
  } catch {
    return [pscustomobject]@{
      message = (ConvertTo-AuditSingleLine ('AGY_ERROR: ' + $matchedJson) 300)
      errorCode = ''
    }
  }

  $shortErr = ConvertTo-AuditSingleLine ([string](Get-AuditProp $parsed 'short_error')) 260
  $errCode = ConvertTo-AuditSingleLine ([string](Get-AuditProp $parsed 'error_code')) 80
  $msg = $shortErr
  if (-not [string]::IsNullOrWhiteSpace($errCode)) {
    if ([string]::IsNullOrWhiteSpace($msg)) {
      $msg = $errCode
    } elseif ($msg.IndexOf($errCode, [StringComparison]::OrdinalIgnoreCase) -lt 0) {
      $msg = $errCode + ': ' + $msg
    }
  }
  if ([string]::IsNullOrWhiteSpace($msg)) {
    $msg = ConvertTo-AuditSingleLine ('AGY_ERROR: ' + $matchedJson) 300
  }

  return [pscustomobject]@{
    message = (ConvertTo-AuditSingleLine $msg 300)
    errorCode = $errCode
  }
}

function Test-AuditModelOutput {
  param([AllowEmptyString()][string]$StdoutText)

  $parsed = Parse-AuditLastJsonObject $StdoutText
  if ($null -eq $parsed) {
    return @{
      ok = $false
      kind = 'unparseable-json'
      error = 'Unparseable JSON on final line of model output.'
      parsed = $null
    }
  }

  $verdictRaw = Get-AuditProp $parsed 'verdict'
  if ($null -eq $verdictRaw -or [string]::IsNullOrWhiteSpace([string]$verdictRaw)) {
    return @{
      ok = $false
      kind = 'missing-verdict'
      error = 'Model JSON output is missing verdict.'
      parsed = $null
    }
  }

  $verdict = ([string]$verdictRaw).Trim().ToLowerInvariant()
  if ($verdict -eq 'block') {
    $hasBlockingFinding = $false
    $findingsRaw = Get-AuditProp $parsed 'findings'
    if ($null -ne $findingsRaw) {
      foreach ($finding in @($findingsRaw)) {
        $sev = ([string](Get-AuditProp $finding 'severity')).Trim().ToLowerInvariant()
        if ($sev -eq 'blocking') {
          $hasBlockingFinding = $true
          break
        }
      }
    }

    $hasFailingAcceptance = $false
    $acceptanceRaw = Get-AuditProp $parsed 'acceptance'
    if ($null -ne $acceptanceRaw) {
      foreach ($acc in @($acceptanceRaw)) {
        $accStatus = ([string](Get-AuditProp $acc 'status')).Trim().ToLowerInvariant()
        if ($accStatus -eq 'missing' -or $accStatus -eq 'substituted') {
          $hasFailingAcceptance = $true
          break
        }
      }
    }

    $hasFailingClaim = $false
    $claimsRaw = Get-AuditProp $parsed 'claims'
    if ($null -ne $claimsRaw) {
      foreach ($claim in @($claimsRaw)) {
        if (Test-AuditHasProp $claim 'holds') {
          $holdsVal = Get-AuditProp $claim 'holds'
          if ($holdsVal -is [bool] -and -not $holdsVal) {
            $hasFailingClaim = $true
            break
          }
        }
      }
    }

    if (-not $hasBlockingFinding -and -not $hasFailingAcceptance -and -not $hasFailingClaim) {
      return @{
        ok = $false
        kind = 'invalid-block'
        error = 'Model returned verdict block with no blocking finding, failing acceptance item, or failing claim.'
        parsed = $null
      }
    }
  }

  return @{
    ok = $true
    kind = 'ok'
    error = ''
    parsed = $parsed
  }
}

function Get-AuditFallbackReason {
  param(
    [string]$Kind = 'error',
    [AllowEmptyString()][string]$ErrorText = '',
    [AllowEmptyString()][string]$StderrText = '',
    [AllowEmptyString()][string]$StdoutText = '',
    $ExitCode = $null,
    [bool]$TimedOut = $false
  )
  if ($TimedOut -or $Kind -eq 'timeout') {
    return 'timeout'
  }
  $combined = $ErrorText + "`n" + $StderrText + "`n" + $StdoutText
  if ($combined -match '(?i)\[1305\]|error\s*1305|code[\s":=]+1305|\b1305\b[^\r\n]{0,60}(?:overload|busy|capacity)|(?:overload|too many requests|service unavailable)[^\r\n]{0,60}\b1305\b') {
    return 'overloaded [1305]'
  }
  if ($combined -match '(?i)model overloaded|server overloaded|\boverloaded\b|high load|capacity exceeded') {
    return 'overloaded'
  }
  if ($combined -match '(?i)\b429\b|rate[\s-]?limit|too many requests|quota exceeded') {
    return 'rate limited'
  }
  if ($combined -match '(?i)\b50[0234]\b|bad gateway|service unavailable|gateway timeout|internal server error') {
    return 'server error'
  }
  if ($combined -match '(?i)ECONNRESET|ETIMEDOUT|ENOTFOUND|ECONNREFUSED|socket hang up|network error|fetch failed') {
    return 'network error'
  }
  if ($Kind -eq 'empty-stdout') { return 'empty output' }
  if ($Kind -eq 'unparseable-json') { return 'unparseable output' }
  if ($Kind -eq 'missing-verdict') { return 'missing verdict' }
  if ($Kind -eq 'invalid-block') { return 'invalid block verdict' }
  if ($Kind -eq 'nonzero-exit') {
    if ($combined -match '\[([0-9]{3,5})\]') {
      return ('exit ' + [string]$ExitCode + ' [' + $Matches[1] + ']')
    }
    if ($null -ne $ExitCode) {
      return ('exit code ' + [string]$ExitCode)
    }
    return 'nonzero exit'
  }
  if ($Kind -eq 'start-failed') { return 'launch error' }
  return 'model error'
}

function Invoke-AuditGlmModel {
  param(
    $Config,
    [string]$PromptBody,
    [string]$WorkDir,
    [string[]]$ExtraDirs,
    [string]$RunDir,
    [int]$TimeoutMinutes
  )

  $rawOutPath = ''
  $rawErrPath = ''
  $hadZCodeDataEnv = Test-Path Env:\ZCODE_DATA_BASE_DIR
  $prevZCodeDataEnv = $null
  if ($hadZCodeDataEnv) { $prevZCodeDataEnv = $env:ZCODE_DATA_BASE_DIR }

  try {
    $promptPath = Get-UniqueRunFilePath -RunDir $RunDir -BaseName 'prompt' -Extension '.md'
    $rawOutPath = Get-UniqueRunFilePath -RunDir $RunDir -BaseName 'model.out' -Extension '.log'
    $rawErrPath = Get-UniqueRunFilePath -RunDir $RunDir -BaseName 'model.err' -Extension '.log'

    Write-AuditText -Path $promptPath -Text $PromptBody

    $zcode = Resolve-AuditZCodeSettings $Config
    Assert-AuditCmdSafePath 'nodePath' $zcode.nodePath
    Assert-AuditCmdSafePath 'zcode.scriptPath' $zcode.scriptPath
    Assert-AuditCmdSafePath 'zcode.dataBaseDir' $zcode.dataBaseDir
    Assert-AuditCmdSafePath 'WorkDir' $WorkDir
    Assert-AuditCmdSafePath 'promptPath' $promptPath

    Sync-AuditZCodeBundle `
      -SourceBundle $zcode.sourcePath `
      -TargetBundle $zcode.scriptPath `
      -SourceBuiltin $zcode.builtinSourcePath `
      -TargetProviderDir $zcode.providerDir `
      -RequireBuiltin $zcode.providerExplicit

    $shortPrompt = 'Read the instructions in ' + $promptPath + ' and inspect the repository tree at ' + $WorkDir + '.'
    $extraArr = @($ExtraDirs)
    if ($extraArr.Count -gt 0) {
      $shortPrompt += ' Additional read-only reference directories you may inspect: ' + ($extraArr -join '; ') + '.'
    }
    $shortPrompt += ' Follow every instruction in that prompt file.'

    # Invoke ZCode CLI the same way scripts/dev-loop/Invoke-GlmReview.ps1 does (plan mode, read-only).
    $glmArgs = (Quote-AuditArg $zcode.scriptPath) +
      ' -p ' + (Quote-AuditArg $shortPrompt) +
      ' --mode plan' +
      ' --disallowed-tools ' + (Quote-AuditArg 'Bash Edit Write') +
      ' --cwd ' + (Quote-AuditArg $WorkDir)

    $env:ZCODE_DATA_BASE_DIR = $zcode.dataBaseDir
    $process = Start-Process -FilePath $zcode.nodePath -ArgumentList $glmArgs `
      -RedirectStandardOutput $rawOutPath -RedirectStandardError $rawErrPath `
      -WorkingDirectory $WorkDir -WindowStyle Hidden -PassThru
    if (-not $process) {
      $errMsg = 'Could not start ZCode CLI (node.exe).'
      return @{
        ok = $false
        parsed = $null
        raw = $rawOutPath
        error = $errMsg
        fallbackReason = (Get-AuditFallbackReason -Kind 'start-failed' -ErrorText $errMsg)
      }
    }
    # Windows PowerShell 5.1 only fills ExitCode for a -PassThru process whose handle was opened before it exited.
    $null = $process.Handle

    $timeoutMs = [int][Math]::Min(([long]$TimeoutMinutes * 60000L), [long][int]::MaxValue)
    $timedOut = -not $process.WaitForExit($timeoutMs)
    if ($timedOut) {
      $killOut = Get-UniqueRunFilePath -RunDir $RunDir -BaseName 'model-kill.out' -Extension '.log'
      $killErr = Get-UniqueRunFilePath -RunDir $RunDir -BaseName 'model-kill.err' -Extension '.log'
      $null = Invoke-AuditTool $script:TaskkillExe ('/T /F /PID ' + $process.Id) $killOut $killErr $RunDir
      $null = $process.WaitForExit(5000)
      Stop-AuditTreeProcesses $WorkDir
      return @{
        ok = $false
        parsed = $null
        raw = $rawOutPath
        error = ('Model timed out after ' + $TimeoutMinutes + ' minutes.')
        fallbackReason = 'timeout'
      }
    }
    $process.WaitForExit()
    Stop-AuditTreeProcesses $WorkDir

    $stderrText = Read-AuditText $rawErrPath
    if ($null -eq $stderrText) { $stderrText = '' }
    $stdoutText = Read-AuditText $rawOutPath
    if ($null -eq $stdoutText) { $stdoutText = '' }

    if ($null -ne $process.ExitCode -and $process.ExitCode -ne 0) {
      $errTail = ConvertTo-AuditSingleLine ([string](Get-AuditTail $rawErrPath 10)) 240
      if ([string]::IsNullOrWhiteSpace($errTail)) {
        $errTail = ConvertTo-AuditSingleLine ([string](Get-AuditTail $rawOutPath 10)) 240
      }
      $errSuffix = ''
      if (-not [string]::IsNullOrWhiteSpace($errTail)) { $errSuffix = ': ' + $errTail }
      $errMsg = 'Model exited with code ' + $process.ExitCode + $errSuffix
      $reason = Get-AuditFallbackReason -Kind 'nonzero-exit' -ErrorText $errMsg -StderrText $stderrText -StdoutText $stdoutText -ExitCode ([int]$process.ExitCode)
      return @{
        ok = $false
        parsed = $null
        raw = $rawOutPath
        error = $errMsg
        fallbackReason = $reason
      }
    }

    if ([string]::IsNullOrWhiteSpace($stdoutText)) {
      $errMsg = 'Model produced empty stdout.'
      $reason = Get-AuditFallbackReason -Kind 'empty-stdout' -ErrorText $errMsg -StderrText $stderrText -StdoutText ''
      return @{
        ok = $false
        parsed = $null
        raw = $rawOutPath
        error = $errMsg
        fallbackReason = $reason
      }
    }

    $validation = Test-AuditModelOutput -StdoutText $stdoutText
    if (-not $validation.ok) {
      $reason = Get-AuditFallbackReason -Kind $validation.kind -ErrorText $validation.error -StderrText $stderrText -StdoutText $stdoutText
      return @{
        ok = $false
        parsed = $null
        raw = $rawOutPath
        error = $validation.error
        fallbackReason = $reason
      }
    }

    return @{
      ok = $true
      parsed = $validation.parsed
      raw = $rawOutPath
      error = ''
      fallbackReason = ''
    }
  } catch {
    $errMsg = ConvertTo-AuditSingleLine $_.Exception.Message 300
    $errText = ''
    $outText = ''
    if (-not [string]::IsNullOrWhiteSpace($rawErrPath)) {
      $readErr = Read-AuditText $rawErrPath
      if ($null -ne $readErr) { $errText = $readErr }
    }
    if (-not [string]::IsNullOrWhiteSpace($rawOutPath)) {
      $readOut = Read-AuditText $rawOutPath
      if ($null -ne $readOut) { $outText = $readOut }
    }
    $reason = Get-AuditFallbackReason -Kind 'error' -ErrorText $errMsg -StderrText $errText -StdoutText $outText
    return @{
      ok = $false
      parsed = $null
      raw = $rawOutPath
      error = $errMsg
      fallbackReason = $reason
    }
  } finally {
    if ($hadZCodeDataEnv) {
      $env:ZCODE_DATA_BASE_DIR = $prevZCodeDataEnv
    } else {
      Remove-Item Env:\ZCODE_DATA_BASE_DIR -ErrorAction SilentlyContinue
    }
  }
}

function Invoke-AuditNeonFallback {
  param(
    $Config,
    [string]$PromptBody,
    [string]$WorkDir,
    [string[]]$ExtraDirs,
    [string]$RunDir,
    [int]$TimeoutMinutes
  )

  $fallbackOutPath = ''
  $fallbackErrPath = ''
  $hadGitPrompt = Test-Path Env:\GIT_TERMINAL_PROMPT
  $prevGitPrompt = $null
  if ($hadGitPrompt) { $prevGitPrompt = $env:GIT_TERMINAL_PROMPT }
  $hadGhPrompt = Test-Path Env:\GH_PROMPT_DISABLED
  $prevGhPrompt = $null
  if ($hadGhPrompt) { $prevGhPrompt = $env:GH_PROMPT_DISABLED }

  try {
    $cleanWorkDir = Get-AuditCleanDirPath $WorkDir
    $cleanRunDir = Get-AuditCleanDirPath $RunDir

    $requestedAgy = ''
    $cfgAgy = Get-AuditProp $Config 'agyPath'
    if ($null -ne $cfgAgy -and -not [string]::IsNullOrWhiteSpace([string]$cfgAgy)) {
      $requestedAgy = ([string]$cfgAgy).Trim()
    }
    $agyExe = Resolve-AuditAgyExecutable -RequestedPath $requestedAgy

    $fallbackModel = $script:DefaultFallbackModel
    $cfgFallbackModel = Get-AuditProp $Config 'fallbackModel'
    if ($null -ne $cfgFallbackModel -and -not [string]::IsNullOrWhiteSpace([string]$cfgFallbackModel)) {
      $fallbackModel = ([string]$cfgFallbackModel).Trim()
    }
    if ($fallbackModel -notmatch '^[A-Za-z0-9._:/-]+$') {
      return @{
        ok = $false
        parsed = $null
        raw = $fallbackOutPath
        error = ('Invalid fallbackModel value: ' + $fallbackModel)
      }
    }

    $fallbackPromptPath = Get-UniqueRunFilePath -RunDir $cleanRunDir -BaseName 'fallback-prompt' -Extension '.md'
    $fallbackOutPath = Get-UniqueRunFilePath -RunDir $cleanRunDir -BaseName 'fallback.out' -Extension '.log'
    $fallbackErrPath = Get-UniqueRunFilePath -RunDir $cleanRunDir -BaseName 'fallback.err' -Extension '.log'

    $readOnlyHeader = "## Read-only audit guard (mandatory)`n`n" +
      "This is a strictly read-only review. Never edit, create, or delete any file in the worktree or elsewhere. " +
      "Never run git commit, git push, gh, or any network command. Only read files and answer with the final JSON object on the last line.`n`n"
    Write-AuditText -Path $fallbackPromptPath -Text ($readOnlyHeader + $PromptBody)

    Assert-AuditCmdSafePath 'agyPath' $agyExe
    Assert-AuditCmdSafePath 'WorkDir' $cleanWorkDir
    Assert-AuditCmdSafePath 'RunDir' $cleanRunDir
    Assert-AuditCmdSafePath 'fallbackPromptPath' $fallbackPromptPath

    $addDirs = New-Object Collections.Generic.List[string]
    $validExtraDirs = New-Object Collections.Generic.List[string]
    $seenDirs = @{}
    $runDirKey = $cleanRunDir.ToLowerInvariant()
    $seenDirs[$runDirKey] = $true
    $null = $addDirs.Add($cleanRunDir)

    $extraArr = @($ExtraDirs)
    foreach ($dir in $extraArr) {
      $cleanDir = Get-AuditCleanDirPath ([string]$dir)
      if ([string]::IsNullOrWhiteSpace($cleanDir)) { continue }
      if (-not (Test-Path -LiteralPath $cleanDir -PathType Container)) { continue }
      Assert-AuditCmdSafePath 'ExtraReadDir' $cleanDir
      $null = $validExtraDirs.Add($cleanDir)
      $dirKey = $cleanDir.ToLowerInvariant()
      if (-not $seenDirs.ContainsKey($dirKey)) {
        $seenDirs[$dirKey] = $true
        $null = $addDirs.Add($cleanDir)
      }
    }

    $shortPrompt = 'Read the full prompt file at ' + $fallbackPromptPath + ' and follow every instruction in it for the repository tree at ' + $cleanWorkDir + '.'
    if ($validExtraDirs.Count -gt 0) {
      $shortPrompt += ' Additional read-only reference directories you may inspect: ' + ($validExtraDirs.ToArray() -join '; ') + '.'
    }
    $shortPrompt += ' This is a read-only review; do not edit files or run mutating or network commands. Answer with the final JSON object on the last line.'

    $agyArgs = '-p ' + (Quote-AuditArg $shortPrompt) +
      ' --model ' + (Quote-AuditArg $fallbackModel) +
      ' --dangerously-skip-permissions' +
      ' --print-timeout ' + ([string]$TimeoutMinutes + 'm')
    foreach ($addDir in $addDirs.ToArray()) {
      $agyArgs += ' --add-dir ' + (Quote-AuditArg $addDir)
    }

    $gitExe = Resolve-AuditGitPath
    $statusBeforeRes = Invoke-AuditGit -GitPath $gitExe -WorkDir $cleanWorkDir -Arguments 'status --porcelain' -RunDir $cleanRunDir
    if ($statusBeforeRes.exitCode -ne 0) {
      return @{
        ok = $false
        parsed = $null
        raw = $fallbackOutPath
        error = ('Could not record pre-run git status before fallback model: ' + (ConvertTo-AuditSingleLine $statusBeforeRes.error 200))
      }
    }

    $env:GIT_TERMINAL_PROMPT = '0'
    $env:GH_PROMPT_DISABLED = '1'

    $process = Start-Process -FilePath $agyExe -ArgumentList $agyArgs `
      -RedirectStandardOutput $fallbackOutPath -RedirectStandardError $fallbackErrPath `
      -WorkingDirectory $cleanWorkDir -WindowStyle Hidden -PassThru
    if (-not $process) {
      return @{
        ok = $false
        parsed = $null
        raw = $fallbackOutPath
        error = 'Could not start Antigravity CLI (agy.exe).'
      }
    }
    # Windows PowerShell 5.1 only fills ExitCode for a -PassThru process whose handle was opened before it exited.
    $null = $process.Handle

    $timeoutMs = [int][Math]::Min(([long]$TimeoutMinutes * 60000L), [long][int]::MaxValue)
    $timedOut = -not $process.WaitForExit($timeoutMs)
    $neonExitCode = $null
    if ($timedOut) {
      $killOut = Get-UniqueRunFilePath -RunDir $cleanRunDir -BaseName 'fallback-kill.out' -Extension '.log'
      $killErr = Get-UniqueRunFilePath -RunDir $cleanRunDir -BaseName 'fallback-kill.err' -Extension '.log'
      $null = Invoke-AuditTool $script:TaskkillExe ('/T /F /PID ' + $process.Id) $killOut $killErr $cleanRunDir
      $null = $process.WaitForExit(5000)
      Stop-AuditTreeProcesses $cleanWorkDir
    } else {
      $process.WaitForExit()
      $neonExitCode = $process.ExitCode
      Stop-AuditTreeProcesses $cleanWorkDir
    }

    $statusAfterRes = Invoke-AuditGit -GitPath $gitExe -WorkDir $cleanWorkDir -Arguments 'status --porcelain' -RunDir $cleanRunDir
    if ($statusAfterRes.exitCode -ne 0 -or $statusAfterRes.text -cne $statusBeforeRes.text) {
      $null = Invoke-AuditGit -GitPath $gitExe -WorkDir $cleanWorkDir -Arguments 'checkout -- .' -RunDir $cleanRunDir
      $null = Invoke-AuditGit -GitPath $gitExe -WorkDir $cleanWorkDir -Arguments 'clean -fd' -RunDir $cleanRunDir
      return @{
        ok = $false
        parsed = $null
        raw = $fallbackOutPath
        error = 'fallback model modified the worktree'
      }
    }

    if ($timedOut) {
      return @{
        ok = $false
        parsed = $null
        raw = $fallbackOutPath
        error = ('Fallback model timed out after ' + $TimeoutMinutes + ' minutes.')
      }
    }

    $fallbackErrText = Read-AuditText $fallbackErrPath
    if ($null -eq $fallbackErrText) { $fallbackErrText = '' }
    $fallbackOutText = Read-AuditText $fallbackOutPath
    if ($null -eq $fallbackOutText) { $fallbackOutText = '' }

    $agyErrInfo = Parse-AuditAgyError -StderrText $fallbackErrText -StdoutText $fallbackOutText
    if ($null -ne $agyErrInfo) {
      return @{
        ok = $false
        parsed = $null
        raw = $fallbackOutPath
        error = ('Fallback model error: ' + $agyErrInfo.message)
      }
    }

    if ($null -ne $neonExitCode -and $neonExitCode -ne 0) {
      $errTail = ConvertTo-AuditSingleLine ([string](Get-AuditTail $fallbackErrPath 10)) 240
      if ([string]::IsNullOrWhiteSpace($errTail)) {
        $errTail = ConvertTo-AuditSingleLine ([string](Get-AuditTail $fallbackOutPath 10)) 240
      }
      $errSuffix = ''
      if (-not [string]::IsNullOrWhiteSpace($errTail)) { $errSuffix = ': ' + $errTail }
      return @{
        ok = $false
        parsed = $null
        raw = $fallbackOutPath
        error = ('Fallback model exited with code ' + $neonExitCode + $errSuffix)
      }
    }

    if ([string]::IsNullOrWhiteSpace($fallbackOutText)) {
      return @{
        ok = $false
        parsed = $null
        raw = $fallbackOutPath
        error = 'Fallback model produced empty stdout.'
      }
    }

    $validation = Test-AuditModelOutput -StdoutText $fallbackOutText
    if (-not $validation.ok) {
      return @{
        ok = $false
        parsed = $null
        raw = $fallbackOutPath
        error = $validation.error
      }
    }

    return @{
      ok = $true
      parsed = $validation.parsed
      raw = $fallbackOutPath
      error = ''
    }
  } catch {
    return @{
      ok = $false
      parsed = $null
      raw = $fallbackOutPath
      error = (ConvertTo-AuditSingleLine $_.Exception.Message 300)
    }
  } finally {
    if ($hadGitPrompt) {
      $env:GIT_TERMINAL_PROMPT = $prevGitPrompt
    } else {
      Remove-Item Env:\GIT_TERMINAL_PROMPT -ErrorAction SilentlyContinue
    }
    if ($hadGhPrompt) {
      $env:GH_PROMPT_DISABLED = $prevGhPrompt
    } else {
      Remove-Item Env:\GH_PROMPT_DISABLED -ErrorAction SilentlyContinue
    }
  }
}

function Invoke-AuditModel {
  param(
    [Parameter(Mandatory = $true)]
    $Config,
    [Parameter(Mandatory = $true)]
    [string]$PromptText,
    [Parameter(Mandatory = $true)]
    [string]$WorkDir,
    [string[]]$ExtraReadDirs = @(),
    [string]$RunDir = ''
  )

  $rawOutPath = ''
  try {
    if ([string]::IsNullOrWhiteSpace($WorkDir) -or -not (Test-Path -LiteralPath $WorkDir -PathType Container)) {
      return @{
        status = 'unavailable'
        result = $null
        raw = $rawOutPath
        error = ('WorkDir does not exist: ' + $WorkDir)
        model = ''
        fallbackReason = ''
      }
    }

    if ([string]::IsNullOrWhiteSpace($RunDir)) {
      $workRoot = [string](Get-AuditProp $Config 'workRoot')
      if ([string]::IsNullOrWhiteSpace($workRoot)) {
        throw 'RunDir was omitted and Config.workRoot is empty.'
      }
      $stamp = [DateTime]::UtcNow.ToString('yyyyMMddTHHmmss')
      $RunDir = Join-Path (Join-Path $workRoot 'runs') ('model-' + $stamp + '-' + [Guid]::NewGuid().ToString('N').Substring(0, 6))
    }
    [IO.Directory]::CreateDirectory($RunDir) | Out-Null

    $extraDirs = New-Object Collections.Generic.List[string]
    if ($null -ne $ExtraReadDirs) {
      foreach ($dir in @($ExtraReadDirs)) {
        if (-not [string]::IsNullOrWhiteSpace([string]$dir)) {
          $null = $extraDirs.Add(([string]$dir).Trim())
        }
      }
    }
    $extraDirsArray = $extraDirs.ToArray()

    $promptBody = $PromptText
    if ($extraDirs.Count -gt 0) {
      $missingInPrompt = @()
      foreach ($dir in $extraDirsArray) {
        if ($promptBody.IndexOf($dir, [StringComparison]::OrdinalIgnoreCase) -lt 0) {
          $missingInPrompt += $dir
        }
      }
      if ($missingInPrompt.Count -gt 0) {
        $promptBody = $promptBody.TrimEnd() + "`n`nAdditional read-only reference directories:`n" + (($missingInPrompt | ForEach-Object { '- ' + $_ }) -join "`n") + "`n"
      }
    }

    $timeoutMinutes = 30
    $cfgTimeout = Get-AuditProp $Config 'timeoutMinutes'
    if ($null -ne $cfgTimeout) {
      $parsedMin = 0
      if ([int]::TryParse([string]$cfgTimeout, [ref]$parsedMin) -and $parsedMin -gt 0) {
        $timeoutMinutes = $parsedMin
      }
    }

    $glmRes = Invoke-AuditGlmModel `
      -Config $Config `
      -PromptBody $promptBody `
      -WorkDir $WorkDir `
      -ExtraDirs $extraDirsArray `
      -RunDir $RunDir `
      -TimeoutMinutes $timeoutMinutes

    $rawOutPath = [string]$glmRes.raw
    if ($glmRes.ok) {
      return @{
        status = 'ok'
        result = $glmRes.parsed
        raw = $rawOutPath
        error = ''
        model = 'GLM-5.4'
        fallbackReason = ''
      }
    }

    $fallbackReason = [string]$glmRes.fallbackReason
    if ([string]::IsNullOrWhiteSpace($fallbackReason)) {
      $fallbackReason = 'model error'
    }

    $neonRes = Invoke-AuditNeonFallback `
      -Config $Config `
      -PromptBody $promptBody `
      -WorkDir $WorkDir `
      -ExtraDirs $extraDirsArray `
      -RunDir $RunDir `
      -TimeoutMinutes $timeoutMinutes

    if ($neonRes.ok) {
      return @{
        status = 'ok'
        result = $neonRes.parsed
        raw = [string]$neonRes.raw
        error = ''
        model = 'Gemini 4 Neon (fallback)'
        fallbackReason = $fallbackReason
      }
    }

    $bestRaw = $rawOutPath
    $neonRaw = [string]$neonRes.raw
    if (-not [string]::IsNullOrWhiteSpace($neonRaw) -and (Test-Path -LiteralPath $neonRaw -PathType Leaf)) {
      $bestRaw = $neonRaw
    }
    $combinedErr = 'GLM-5.4 failed (' + [string]$glmRes.error + '); Gemini 4 Neon fallback unavailable: ' + [string]$neonRes.error
    return @{
      status = 'unavailable'
      result = $null
      raw = $bestRaw
      error = $combinedErr
      model = ''
      fallbackReason = $fallbackReason
    }
  } catch {
    return @{
      status = 'unavailable'
      result = $null
      raw = $rawOutPath
      error = (ConvertTo-AuditSingleLine $_.Exception.Message 300)
      model = ''
      fallbackReason = ''
    }
  }
}

function Test-ArbiterRulingEntries {
  param(
    $Items,
    [string]$KeyProp,
    [string]$SectionName
  )
  if ($null -eq $Items) { return ($SectionName + ' must be an array, got null.') }
  foreach ($entry in @($Items)) {
    if ($null -eq $entry -or $entry -isnot [pscustomobject]) {
      return ($SectionName + ' contains a non-object entry.')
    }
    $keyVal = [string](Get-AuditProp $entry $KeyProp)
    if ([string]::IsNullOrWhiteSpace($keyVal)) {
      return ($SectionName + ' entry is missing ' + $KeyProp + '.')
    }
    $ruling = ([string](Get-AuditProp $entry 'ruling')).Trim().ToLowerInvariant()
    if ($ruling -ne 'uphold' -and $ruling -ne 'overturn') {
      return ($SectionName + ' entry has invalid ruling "' + $ruling + '" (expected uphold or overturn).')
    }
  }
  return ''
}

function Invoke-ArbiterModel {
  param(
    [Parameter(Mandatory = $true)]
    $Config,
    [Parameter(Mandatory = $true)]
    [string]$PromptText,
    [Parameter(Mandatory = $true)]
    [string]$WorkDir,
    [string]$RunDir = ''
  )

  $rawOutPath = ''
  try {
    if ([string]::IsNullOrWhiteSpace($WorkDir) -or -not (Test-Path -LiteralPath $WorkDir -PathType Container)) {
      return @{
        status = 'unavailable'
        result = $null
        raw = $rawOutPath
        error = ('WorkDir does not exist: ' + $WorkDir)
      }
    }

    if ([string]::IsNullOrWhiteSpace($RunDir)) {
      $workRoot = [string](Get-AuditProp $Config 'workRoot')
      if ([string]::IsNullOrWhiteSpace($workRoot)) {
        throw 'RunDir was omitted and Config.workRoot is empty.'
      }
      $stamp = [DateTime]::UtcNow.ToString('yyyyMMddTHHmmss')
      $RunDir = Join-Path (Join-Path $workRoot 'runs') ('arbiter-' + $stamp + '-' + [Guid]::NewGuid().ToString('N').Substring(0, 6))
    }
    [IO.Directory]::CreateDirectory($RunDir) | Out-Null

    $promptPath = Get-UniqueRunFilePath -RunDir $RunDir -BaseName 'arbiter-prompt' -Extension '.md'
    $rawOutPath = Get-UniqueRunFilePath -RunDir $RunDir -BaseName 'arbiter.out' -Extension '.log'
    $rawErrPath = Get-UniqueRunFilePath -RunDir $RunDir -BaseName 'arbiter.err' -Extension '.log'
    Write-AuditText -Path $promptPath -Text $PromptText

    $devinExe = $script:DefaultDevinCli
    $cfgDevin = Get-AuditProp $Config 'devinCli'
    if ($null -ne $cfgDevin -and -not [string]::IsNullOrWhiteSpace([string]$cfgDevin)) {
      $devinExe = ([string]$cfgDevin).Trim()
    }
    if (-not (Test-Path -LiteralPath $devinExe -PathType Leaf)) {
      $fallbackCmd = $null
      if ($devinExe.Equals($script:DefaultDevinCli, [StringComparison]::OrdinalIgnoreCase)) {
        $fallbackCmd = Get-Command -Name 'devin' -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
      }
      if ($null -ne $fallbackCmd -and -not [string]::IsNullOrWhiteSpace($fallbackCmd.Source)) {
        $devinExe = $fallbackCmd.Source
      } else {
        return @{
          status = 'unavailable'
          result = $null
          raw = $rawOutPath
          error = ('Devin CLI not found at ' + $devinExe)
        }
      }
    }

    $arbiterModel = $script:DefaultArbiterModel
    $cfgModel = Get-AuditProp $Config 'arbiterModel'
    if ($null -ne $cfgModel -and -not [string]::IsNullOrWhiteSpace([string]$cfgModel)) {
      $arbiterModel = ([string]$cfgModel).Trim()
    }
    if ($arbiterModel -notmatch '^[A-Za-z0-9._:/-]+$') {
      return @{
        status = 'unavailable'
        result = $null
        raw = $rawOutPath
        error = ('Invalid arbiterModel value: ' + $arbiterModel)
      }
    }

    $timeoutMinutes = 30
    $cfgTimeout = Get-AuditProp $Config 'arbiterTimeoutMinutes'
    if ($null -ne $cfgTimeout) {
      $parsedMin = 0
      if ([int]::TryParse([string]$cfgTimeout, [ref]$parsedMin) -and $parsedMin -gt 0) {
        $timeoutMinutes = $parsedMin
      }
    }

    Assert-AuditCmdSafePath 'devinCli' $devinExe
    Assert-AuditCmdSafePath 'WorkDir' $WorkDir
    Assert-AuditCmdSafePath 'promptPath' $promptPath
    Assert-AuditCmdSafePath 'rawOutPath' $rawOutPath
    Assert-AuditCmdSafePath 'rawErrPath' $rawErrPath

    # Mirror scripts/pr-review/Invoke-PrReview.ps1: launch via cmd.exe /d /c and kill the process tree on timeout.
    # Redirect stdout and stderr separately so stderr diagnostics cannot corrupt the final JSON line on stdout.
    $inner = (Quote-AuditArg $devinExe) +
      ' --model ' + $arbiterModel +
      ' --permission-mode auto --respect-workspace-trust false --prompt-file ' + (Quote-AuditArg $promptPath) +
      ' -p > ' + (Quote-AuditArg $rawOutPath) + ' 2> ' + (Quote-AuditArg $rawErrPath)

    $previousEap = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    $process = $null
    try {
      $process = Start-Process -FilePath $script:CmdExe -ArgumentList ('/d /c "' + $inner + '"') `
        -WorkingDirectory $WorkDir -PassThru -WindowStyle Hidden
    } finally {
      $ErrorActionPreference = $previousEap
    }
    if (-not $process) {
      return @{
        status = 'unavailable'
        result = $null
        raw = $rawOutPath
        error = 'Could not start Devin CLI for arbitration.'
      }
    }
    # Windows PowerShell 5.1 only fills ExitCode for a -PassThru process whose handle was opened before it exited.
    $null = $process.Handle

    $timeoutMs = [int][Math]::Min(([long]$timeoutMinutes * 60000L), [long][int]::MaxValue)
    $timedOut = -not $process.WaitForExit($timeoutMs)
    if ($timedOut) {
      $killOut = Get-UniqueRunFilePath -RunDir $RunDir -BaseName 'arbiter-kill.out' -Extension '.log'
      $killErr = Get-UniqueRunFilePath -RunDir $RunDir -BaseName 'arbiter-kill.err' -Extension '.log'
      $null = Invoke-AuditTool $script:TaskkillExe ('/T /F /PID ' + $process.Id) $killOut $killErr $RunDir
      $null = $process.WaitForExit(5000)
      Stop-AuditTreeProcesses $WorkDir
      return @{
        status = 'unavailable'
        result = $null
        raw = $rawOutPath
        error = ('Arbiter timed out after ' + $timeoutMinutes + ' minutes.')
      }
    }
    $process.WaitForExit()
    Stop-AuditTreeProcesses $WorkDir

    if ($null -ne $process.ExitCode -and $process.ExitCode -ne 0) {
      $errTail = ConvertTo-AuditSingleLine ([string](Get-AuditTail $rawErrPath 10)) 240
      if ([string]::IsNullOrWhiteSpace($errTail)) {
        $errTail = ConvertTo-AuditSingleLine ([string](Get-AuditTail $rawOutPath 10)) 240
      }
      return @{
        status = 'unavailable'
        result = $null
        raw = $rawOutPath
        error = ('Arbiter exited with code ' + $process.ExitCode + $(if ($errTail) { ': ' + $errTail } else { '' }))
      }
    }

    $stdoutText = Read-AuditText $rawOutPath
    if ([string]::IsNullOrWhiteSpace($stdoutText)) {
      return @{
        status = 'unavailable'
        result = $null
        raw = $rawOutPath
        error = 'Arbiter produced empty stdout.'
      }
    }

    $parsed = Parse-AuditLastJsonObject $stdoutText
    if ($null -eq $parsed) {
      return @{
        status = 'unavailable'
        result = $null
        raw = $rawOutPath
        error = 'Unparseable JSON on final line of arbiter output.'
      }
    }

    foreach ($reqKey in @('rulings', 'acceptance', 'claims')) {
      if (-not (Test-AuditHasProp $parsed $reqKey)) {
        return @{
          status = 'unavailable'
          result = $null
          raw = $rawOutPath
          error = ('Arbiter JSON output is missing required key: ' + $reqKey)
        }
      }
    }

    $valErr = Test-ArbiterRulingEntries -Items (Get-AuditProp $parsed 'rulings') -KeyProp 'id' -SectionName 'rulings'
    if (-not [string]::IsNullOrWhiteSpace($valErr)) {
      return @{ status = 'unavailable'; result = $null; raw = $rawOutPath; error = $valErr }
    }
    $valErr = Test-ArbiterRulingEntries -Items (Get-AuditProp $parsed 'acceptance') -KeyProp 'item' -SectionName 'acceptance'
    if (-not [string]::IsNullOrWhiteSpace($valErr)) {
      return @{ status = 'unavailable'; result = $null; raw = $rawOutPath; error = $valErr }
    }
    $valErr = Test-ArbiterRulingEntries -Items (Get-AuditProp $parsed 'claims') -KeyProp 'claim' -SectionName 'claims'
    if (-not [string]::IsNullOrWhiteSpace($valErr)) {
      return @{ status = 'unavailable'; result = $null; raw = $rawOutPath; error = $valErr }
    }

    return @{
      status = 'ok'
      result = $parsed
      raw = $rawOutPath
      error = ''
    }
  } catch {
    return @{
      status = 'unavailable'
      result = $null
      raw = $rawOutPath
      error = (ConvertTo-AuditSingleLine $_.Exception.Message 300)
    }
  }
}

Export-ModuleMember -Function @(
  'Get-AuditConfig',
  'Get-AuditToken',
  'Invoke-AuditApi',
  'Invoke-AuditModel',
  'Invoke-ArbiterModel'
)
