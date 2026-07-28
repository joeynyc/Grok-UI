#Requires -Version 5.1
<#
.SYNOPSIS
  Remove the Windows desktop launcher, scheduled task, and optional local stubs.

.DESCRIPTION
  Does not uninstall the npm package or delete session history under ~/.grok.
  By default keeps %USERPROFILE%\.grok-ui\logs for troubleshooting.
#>
param(
  [switch]$RemoveState,
  [switch]$RemoveLogs
)

$ErrorActionPreference = 'Continue'
$taskName = 'GrokUI'
$stateDir = Join-Path $env:USERPROFILE '.grok-ui'

Unregister-ScheduledTask -TaskName $taskName -Confirm:$false -ErrorAction SilentlyContinue
Write-Host "Removed scheduled task (if present): $taskName"

$desktop = [Environment]::GetFolderPath('Desktop')
$startMenu = Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs'
foreach ($lnk in @(
  (Join-Path $desktop 'Grok UI.lnk'),
  (Join-Path $startMenu 'Grok UI.lnk')
)) {
  if (Test-Path $lnk) {
    Remove-Item $lnk -Force
    Write-Host "Removed $lnk"
  }
}

if ($RemoveState -and (Test-Path $stateDir)) {
  if ($RemoveLogs) {
    Remove-Item $stateDir -Recurse -Force
    Write-Host "Removed $stateDir"
  } else {
    Get-ChildItem $stateDir -Force | Where-Object {
      $_.Name -ne 'logs' -and $_.Name -ne 'state.json'
    } | ForEach-Object {
      Remove-Item $_.FullName -Recurse -Force -ErrorAction SilentlyContinue
      Write-Host "Removed $($_.FullName)"
    }
    Write-Host "Kept logs and state.json under $stateDir"
  }
} else {
  Write-Host "Left $stateDir in place (use -RemoveState to clean stubs)."
}

Write-Host 'Uninstall complete. The grok-ui npm package was not removed.'
