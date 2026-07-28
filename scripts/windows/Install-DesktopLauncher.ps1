#Requires -Version 5.1
<#
.SYNOPSIS
  Install a one-click Windows desktop launcher for Grok UI.

.DESCRIPTION
  - Copies supervisor scripts into %USERPROFILE%\.grok-ui
  - Registers a Scheduled Task that keeps the server running
  - Builds a small GrokUI.exe stub (when .NET csc is available) for taskbar pinning
  - Creates Desktop and Start Menu shortcuts with the package favicon

  Prerequisites: Node.js 22+, grok-ui installed (npm i -g grok-ui) or this repo built.

.EXAMPLE
  # From a global install
  powershell -ExecutionPolicy Bypass -File "$env:APPDATA\npm\node_modules\grok-ui\scripts\windows\Install-DesktopLauncher.ps1"

.EXAMPLE
  # From a source checkout
  powershell -ExecutionPolicy Bypass -File .\scripts\windows\Install-DesktopLauncher.ps1
#>
param(
  [int]$Port = 4310,
  [switch]$SkipShortcuts,
  [switch]$SkipExe
)

$ErrorActionPreference = 'Stop'

function Get-PackageRoot {
  if ($PSScriptRoot) {
    $candidate = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
    if (Test-Path (Join-Path $candidate 'bin\grok-ui.mjs')) { return $candidate }
    if (Test-Path (Join-Path $candidate 'package.json')) { return $candidate }
  }
  $global = Join-Path $env:APPDATA 'npm\node_modules\grok-ui'
  if (Test-Path (Join-Path $global 'bin\grok-ui.mjs')) { return $global }
  throw 'Could not locate the grok-ui package root. Install with: npm install -g grok-ui'
}

function ConvertTo-Ico {
  param([string]$PngPath, [string]$IcoPath)
  Add-Type -AssemblyName System.Drawing
  $srcImg = [System.Drawing.Image]::FromFile($PngPath)
  try {
    $sizes = @(16, 32, 48, 256)
    $ms = New-Object System.IO.MemoryStream
    $bw = New-Object System.IO.BinaryWriter $ms
    $bw.Write([uint16]0)
    $bw.Write([uint16]1)
    $bw.Write([uint16]$sizes.Count)
    $imageData = @()
    foreach ($size in $sizes) {
      $bmp = New-Object System.Drawing.Bitmap $size, $size
      $g = [System.Drawing.Graphics]::FromImage($bmp)
      $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
      $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality
      $g.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
      $g.Clear([System.Drawing.Color]::Transparent)
      $g.DrawImage($srcImg, 0, 0, $size, $size)
      $g.Dispose()
      $pngMs = New-Object System.IO.MemoryStream
      $bmp.Save($pngMs, [System.Drawing.Imaging.ImageFormat]::Png)
      $imageData += , $pngMs.ToArray()
      $pngMs.Dispose()
      $bmp.Dispose()
    }
    $offset = 6 + (16 * $sizes.Count)
    for ($i = 0; $i -lt $sizes.Count; $i++) {
      $size = $sizes[$i]
      $bytes = $imageData[$i]
      $w = if ($size -ge 256) { 0 } else { $size }
      $h = if ($size -ge 256) { 0 } else { $size }
      $bw.Write([byte]$w)
      $bw.Write([byte]$h)
      $bw.Write([byte]0)
      $bw.Write([byte]0)
      $bw.Write([uint16]1)
      $bw.Write([uint16]32)
      $bw.Write([uint32]$bytes.Length)
      $bw.Write([uint32]$offset)
      $offset += $bytes.Length
    }
    foreach ($bytes in $imageData) { $bw.Write($bytes) }
    $bw.Flush()
    [System.IO.File]::WriteAllBytes($IcoPath, $ms.ToArray())
    $bw.Dispose()
    $ms.Dispose()
  } finally {
    $srcImg.Dispose()
  }
}

function New-LauncherExe {
  param([string]$ExePath, [string]$StartScriptPath)
  $csc = @(
    (Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'),
    (Join-Path $env:WINDIR 'Microsoft.NET\Framework\v4.0.30319\csc.exe')
  ) | Where-Object { Test-Path $_ } | Select-Object -First 1
  if (-not $csc) { return $false }

  $escaped = $StartScriptPath.Replace('\', '\\').Replace('"', '\"')
  $src = @"
using System;
using System.Diagnostics;
using System.Windows.Forms;

internal static class Program
{
    [STAThread]
    static void Main()
    {
        string script = "$escaped";
        var psi = new ProcessStartInfo
        {
            FileName = "powershell.exe",
            Arguments = "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File \"" + script + "\"",
            UseShellExecute = false,
            CreateNoWindow = true,
            WindowStyle = ProcessWindowStyle.Hidden
        };
        try { using (Process.Start(psi)) { } }
        catch (Exception ex)
        {
            MessageBox.Show("Could not start Grok UI:\n" + ex.Message, "Grok UI",
                MessageBoxButtons.OK, MessageBoxIcon.Error);
        }
    }
}
"@
  $tmp = Join-Path $env:TEMP 'GrokUI-Launcher.cs'
  Set-Content -Path $tmp -Value $src -Encoding UTF8
  & $csc /nologo /target:winexe /r:System.Windows.Forms.dll /out:"$ExePath" "$tmp" | Out-Null
  return ($LASTEXITCODE -eq 0 -and (Test-Path $ExePath))
}

$packageRoot = Get-PackageRoot
$stateDir = Join-Path $env:USERPROFILE '.grok-ui'
$logDir = Join-Path $stateDir 'logs'
New-Item -ItemType Directory -Force -Path $stateDir, $logDir | Out-Null

Write-Host "Package root: $packageRoot"
Write-Host "State dir:    $stateDir"

# Remember package root for the supervisor (helps when npm global path changes)
[System.IO.File]::WriteAllText((Join-Path $stateDir 'package-root.txt'), $packageRoot)

$windowsScripts = Join-Path $packageRoot 'scripts\windows'
foreach ($name in @('Run-GrokUI-Service.ps1', 'Start-GrokUI.ps1')) {
  $src = Join-Path $windowsScripts $name
  if (-not (Test-Path $src)) { throw "Missing $src" }
  Copy-Item $src (Join-Path $stateDir $name) -Force
}

# Icon from packaged favicon
$icoPath = Join-Path $stateDir 'grok-ui.ico'
$pngCandidates = @(
  (Join-Path $packageRoot 'dist\favicon.png'),
  (Join-Path $packageRoot 'public\favicon.png')
) | Where-Object { Test-Path $_ }
if ($pngCandidates.Count -gt 0) {
  try {
    ConvertTo-Ico -PngPath $pngCandidates[0] -IcoPath $icoPath
    Write-Host "Icon: $icoPath"
  } catch {
    Write-Warning "Could not build .ico from favicon: $($_.Exception.Message)"
  }
}

$startScript = Join-Path $stateDir 'Start-GrokUI.ps1'
$serviceScript = Join-Path $stateDir 'Run-GrokUI-Service.ps1'
$exePath = Join-Path $stateDir 'GrokUI.exe'
$targetPath = $null
$targetArgs = $null

if (-not $SkipExe) {
  if (New-LauncherExe -ExePath $exePath -StartScriptPath $startScript) {
    Write-Host "Launcher exe: $exePath"
    $targetPath = $exePath
  } else {
    Write-Warning 'csc.exe not found; shortcuts will invoke PowerShell directly.'
  }
}

if (-not $targetPath) {
  $targetPath = Join-Path $env:WINDIR 'System32\WindowsPowerShell\v1.0\powershell.exe'
  $targetArgs = "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$startScript`""
}

# Scheduled task for durable supervisor
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
Register-ScheduledTask -TaskName 'GrokUI' -Action $action -Settings $settings -Principal $principal -Force | Out-Null
Write-Host "Scheduled task: GrokUI"

if (-not $SkipShortcuts) {
  $desktop = [Environment]::GetFolderPath('Desktop')
  $startMenu = Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs'
  $wsh = New-Object -ComObject WScript.Shell
  foreach ($lnkPath in @(
    (Join-Path $desktop 'Grok UI.lnk'),
    (Join-Path $startMenu 'Grok UI.lnk')
  )) {
    $sc = $wsh.CreateShortcut($lnkPath)
    $sc.TargetPath = $targetPath
    if ($targetArgs) { $sc.Arguments = $targetArgs }
    $sc.WorkingDirectory = $stateDir
    if (Test-Path $icoPath) { $sc.IconLocation = "$icoPath,0" }
    $sc.Description = 'Start Grok UI and open the browser'
    $sc.WindowStyle = 7
    $sc.Save()
    Write-Host "Shortcut: $lnkPath"
  }
}

Write-Host ''
Write-Host 'Done. Double-click "Grok UI" on the Desktop (or Start Menu) to launch.'
Write-Host "Dashboard: http://127.0.0.1:$Port"
Write-Host "Logs:      $logDir"
Write-Host ''
Write-Host 'Pin to taskbar: Start -> type "Grok UI" -> right-click -> Pin to taskbar'
