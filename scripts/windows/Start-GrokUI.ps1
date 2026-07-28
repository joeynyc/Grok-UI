#Requires -Version 5.1
<#
.SYNOPSIS
  Ensure the Grok UI local server is running, then open the dashboard in a browser.

.DESCRIPTION
  Uses the Windows Scheduled Task registered by Install-DesktopLauncher.ps1 so the
  server survives terminal/agent job cleanup. Safe to double-click while already up.
#>
param(
  [int]$Port = 4310,
  [switch]$NoBrowser
)

$ErrorActionPreference = 'Stop'
$Url = "http://127.0.0.1:$Port"
$taskName = 'GrokUI'
$stateDir = Join-Path $env:USERPROFILE '.grok-ui'
$logDir = Join-Path $stateDir 'logs'
$serviceScript = Join-Path $stateDir 'Run-GrokUI-Service.ps1'
New-Item -ItemType Directory -Force -Path $logDir | Out-Null

function Test-Ready {
  try {
    $req = [System.Net.HttpWebRequest]::Create($Url)
    $req.Timeout = 2000
    $req.Method = 'GET'
    $resp = $req.GetResponse()
    $code = [int]$resp.StatusCode
    $resp.Close()
    return ($code -ge 200 -and $code -lt 500)
  } catch {
    return $false
  }
}

function Ensure-Task {
  if (-not (Test-Path $serviceScript)) {
    throw "Supervisor script missing at $serviceScript. Run Install-DesktopLauncher.ps1 first."
  }
  $ps = Join-Path $env:WINDIR 'System32\WindowsPowerShell\v1.0\powershell.exe'
  $action = New-ScheduledTaskAction -Execute $ps -Argument "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$serviceScript`" -Port $Port"
  $settings = New-ScheduledTaskSettingsSet `
    -AllowStartIfOnBatteries `
    -DontStopIfGoingOnBatteries `
    -StartWhenAvailable `
    -ExecutionTimeLimit ([TimeSpan]::Zero) `
    -RestartCount 5 `
    -RestartInterval (New-TimeSpan -Minutes 1)
  $principal = New-ScheduledTaskPrincipal -UserId $env:USERNAME -LogonType Interactive -RunLevel Limited
  Register-ScheduledTask -TaskName $taskName -Action $action -Settings $settings -Principal $principal -Force | Out-Null
}

if (-not (Test-Ready)) {
  Ensure-Task
  $task = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
  if ($task -and $task.State -eq 'Running') {
    # Task claims Running but port is dead - bounce it
    Stop-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
    Start-Sleep -Milliseconds 500
    Remove-Item (Join-Path $stateDir 'service.pid') -Force -ErrorAction SilentlyContinue
  }
  Start-ScheduledTask -TaskName $taskName

  $deadline = (Get-Date).AddSeconds(45)
  while (-not (Test-Ready)) {
    if ((Get-Date) -gt $deadline) {
      Add-Type -AssemblyName System.Windows.Forms -ErrorAction SilentlyContinue
      [System.Windows.Forms.MessageBox]::Show(
        "Grok UI did not become ready within 45s.`nURL: $Url`n`nLogs: $logDir",
        'Grok UI',
        'OK',
        'Error'
      ) | Out-Null
      exit 1
    }
    Start-Sleep -Milliseconds 400
  }
}

if (-not $NoBrowser) {
  Start-Process $Url
}
exit 0
