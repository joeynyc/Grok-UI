#Requires -Version 5.1
<#
.SYNOPSIS
  Long-running Grok UI supervisor for Windows: keep the local server up, log crashes, auto-restart.

.DESCRIPTION
  Intended to run via Scheduled Task (see Install-DesktopLauncher.ps1) so the process is not
  killed when a terminal or agent shell job ends. Logs live under %USERPROFILE%\.grok-ui\logs.
#>
param(
  [int]$Port = 4310,
  [string]$HostAddress = '127.0.0.1'
)

$ErrorActionPreference = 'Continue'
$base = Join-Path $env:USERPROFILE '.grok-ui'
$logDir = Join-Path $base 'logs'
New-Item -ItemType Directory -Force -Path $logDir | Out-Null

$logFile = Join-Path $logDir 'service.log'
$stdoutFile = Join-Path $logDir 'server-stdout.log'
$stderrFile = Join-Path $logDir 'server-stderr.log'
$pidFile = Join-Path $base 'service.pid'
$serverPidFile = Join-Path $base 'server.pid'

function Write-Log {
  param([string]$Message)
  try {
    $stamp = (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ss.fffZ')
    [System.IO.File]::AppendAllText($logFile, ($stamp + ' ' + $Message + [Environment]::NewLine))
  } catch {}
}

function Test-Ready {
  try {
    $req = [System.Net.HttpWebRequest]::Create("http://${HostAddress}:$Port/")
    $req.Timeout = 2000
    $req.ReadWriteTimeout = 2000
    $req.Method = 'GET'
    $resp = $req.GetResponse()
    $code = [int]$resp.StatusCode
    $resp.Close()
    return ($code -ge 200 -and $code -lt 500)
  } catch {
    return $false
  }
}

function Resolve-NodePath {
  $candidates = @(
    (Get-Command node -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Source),
    (Join-Path $env:ProgramFiles 'nodejs\node.exe'),
    (Join-Path ${env:ProgramFiles(x86)} 'nodejs\node.exe')
  ) | Where-Object { $_ }
  foreach ($c in $candidates) {
    if (Test-Path $c) { return $c }
  }
  return $null
}

function Resolve-GrokUiEntry {
  if ($env:GROK_UI_ENTRY -and (Test-Path $env:GROK_UI_ENTRY)) {
    return (Resolve-Path $env:GROK_UI_ENTRY).Path
  }

  $cmd = Get-Command grok-ui.cmd -ErrorAction SilentlyContinue
  if ($cmd) {
    $npmGrok = Join-Path $env:APPDATA 'npm\node_modules\grok-ui\bin\grok-ui.mjs'
    if (Test-Path $npmGrok) { return $npmGrok }
  }

  $global = Join-Path $env:APPDATA 'npm\node_modules\grok-ui\bin\grok-ui.mjs'
  if (Test-Path $global) { return $global }

  # Running from a source checkout / local install of this package
  $here = $PSScriptRoot
  if ($here) {
    $fromScripts = Join-Path $here '..\..\bin\grok-ui.mjs'
    if (Test-Path $fromScripts) { return (Resolve-Path $fromScripts).Path }
  }

  $localState = Join-Path $base 'package-root.txt'
  if (Test-Path $localState) {
    $root = (Get-Content $localState -Raw).Trim()
    $entry = Join-Path $root 'bin\grok-ui.mjs'
    if (Test-Path $entry) { return $entry }
  }

  return $null
}

function Stop-PortHolders {
  try {
    $lines = netstat -ano | Select-String (":$Port\s+.*LISTENING")
    foreach ($line in $lines) {
      $parts = @(($line.ToString() -split '\s+') | Where-Object { $_ })
      $listenPid = $parts[-1]
      if ($listenPid -match '^\d+$' -and [int]$listenPid -gt 0) {
        Write-Log ("Killing listener PID {0} on :{1}" -f $listenPid, $Port)
        Stop-Process -Id ([int]$listenPid) -Force -ErrorAction SilentlyContinue
      }
    }
  } catch {
    Write-Log ("Stop-PortHolders: {0}" -f $_.Exception.Message)
  }
}

try {
  Write-Log ("Supervisor boot PID={0}" -f $PID)

  if (Test-Path $pidFile) {
    $old = 0
    $raw = [string](Get-Content $pidFile -Raw)
    [void][int]::TryParse($raw.Trim(), [ref]$old)
    if ($old -gt 0 -and $old -ne $PID) {
      $existing = Get-Process -Id $old -ErrorAction SilentlyContinue
      if ($existing) {
        Write-Log ("Another supervisor is running (PID {0}) - exit" -f $old)
        exit 0
      }
    }
  }
  [System.IO.File]::WriteAllText($pidFile, "$PID")

  $node = Resolve-NodePath
  $entry = Resolve-GrokUiEntry
  Write-Log ("node={0} exists={1}" -f $node, [bool]($node -and (Test-Path $node)))
  Write-Log ("entry={0} exists={1}" -f $entry, [bool]($entry -and (Test-Path $entry)))

  if (-not $node) { Write-Log 'FATAL: node.exe missing'; exit 1 }
  if (-not $entry) { Write-Log 'FATAL: grok-ui.mjs not found (install with npm i -g grok-ui)'; exit 1 }

  $restartTimes = New-Object System.Collections.ArrayList

  while ($true) {
    $cutoff = (Get-Date).AddMinutes(-10)
    for ($i = $restartTimes.Count - 1; $i -ge 0; $i--) {
      if ($restartTimes[$i] -lt $cutoff) { [void]$restartTimes.RemoveAt($i) }
    }
    if ($restartTimes.Count -ge 30) {
      Write-Log ('Too many restarts ({0} in 10 min) - sleep 60s' -f $restartTimes.Count)
      Start-Sleep -Seconds 60
      continue
    }

    if (Test-Ready) {
      Write-Log ("Already serving on :{0} - monitor" -f $Port)
      while (Test-Ready) { Start-Sleep -Seconds 5 }
      Write-Log 'Stopped responding - restarting'
    }

    Stop-PortHolders
    Start-Sleep -Milliseconds 500

    Write-Log ("Starting server: {0} {1}" -f $node, $entry)

    $psi = New-Object System.Diagnostics.ProcessStartInfo
    $psi.FileName = $node
    $psi.Arguments = ('"{0}" start --no-open --host {1} --port {2}' -f $entry, $HostAddress, $Port)
    $psi.WorkingDirectory = $base
    $psi.UseShellExecute = $false
    $psi.CreateNoWindow = $true
    $psi.RedirectStandardOutput = $true
    $psi.RedirectStandardError = $true
    $psi.RedirectStandardInput = $true

    try {
      $proc = New-Object System.Diagnostics.Process
      $proc.StartInfo = $psi
      [void]$proc.Start()
    } catch {
      Write-Log ("Start failed: {0}" -f $_.Exception.Message)
      Start-Sleep -Seconds 5
      continue
    }

    [System.IO.File]::WriteAllText($serverPidFile, "$($proc.Id)")
    Write-Log ("Server PID={0}" -f $proc.Id)

    $outTask = $proc.StandardOutput.ReadToEndAsync()
    $errTask = $proc.StandardError.ReadToEndAsync()

    $ready = $false
    for ($i = 0; $i -lt 80; $i++) {
      if ($proc.HasExited) { break }
      if (Test-Ready) { $ready = $true; break }
      Start-Sleep -Milliseconds 250
    }
    if ($ready) {
      Write-Log ("Ready http://{0}:{1}" -f $HostAddress, $Port)
    } else {
      Write-Log 'Not ready yet; waiting on process'
    }

    $proc.WaitForExit()
    $code = $proc.ExitCode
    try {
      $outText = $outTask.Result
      $errText = $errTask.Result
      if ($outText) { [System.IO.File]::WriteAllText($stdoutFile, $outText) }
      if ($errText) { [System.IO.File]::WriteAllText($stderrFile, $errText) }
      if ($errText) {
        Write-Log ('stderr: {0}' -f $errText.Substring(0, [Math]::Min(500, $errText.Length)))
      }
      if ($outText) {
        Write-Log ('stdout: {0}' -f $outText.Substring(0, [Math]::Min(300, $outText.Length)))
      }
    } catch {
      Write-Log ("log drain error: {0}" -f $_.Exception.Message)
    }

    Write-Log ("Server exited code={0}" -f $code)
    [void]$restartTimes.Add((Get-Date))
    Start-Sleep -Seconds 2
  }
}
catch {
  Write-Log ("SUPERVISOR CRASH: {0}" -f $_.Exception.Message)
  if ($_.ScriptStackTrace) { Write-Log $_.ScriptStackTrace }
  exit 1
}
finally {
  Remove-Item $pidFile -Force -ErrorAction SilentlyContinue
}
