# Windows desktop launcher

One-click start for Grok UI on Windows: ensure the local server is running, open the browser, and keep the process alive outside short-lived terminal/agent shells.

## What you get

| Piece | Role |
| --- | --- |
| **Desktop / Start Menu shortcut** | “Grok UI” with package icon |
| **`GrokUI.exe` stub** (when .NET Framework compilers are available) | Pin-friendly target (not raw `powershell.exe`) |
| **Scheduled Task `GrokUI`** | Runs the supervisor outside job objects that kill child processes when a tool shell exits |
| **Supervisor** | Starts `grok-ui`, restarts on crash, logs under `%USERPROFILE%\.grok-ui\logs` |

Loopback-only by default (`127.0.0.1:4310`). Credentials never enter the browser.

## Prerequisites

- Windows 10/11
- PowerShell 5.1+
- Node.js 22+
- Grok UI installed (`npm install -g grok-ui`) **or** a built source checkout of this repository
- Working Grok Build CLI + auth (`grok-ui doctor`)

## Install

### From a global npm install

```powershell
powershell -ExecutionPolicy Bypass -File "$env:APPDATA\npm\node_modules\grok-ui\scripts\windows\Install-DesktopLauncher.ps1"
```

### From a source checkout

```powershell
npm ci
npm run build
powershell -ExecutionPolicy Bypass -File .\scripts\windows\Install-DesktopLauncher.ps1
```

### Options

| Flag | Meaning |
| --- | --- |
| `-Port 4310` | Local port (default `4310`) |
| `-SkipShortcuts` | Register the task only |
| `-SkipExe` | Skip building `GrokUI.exe` (shortcut targets PowerShell) |

## Use

1. Double-click **Grok UI** on the Desktop or Start Menu.
2. If the server is already up, the browser opens immediately.
3. If not, the scheduled supervisor starts it, waits until ready, then opens `http://127.0.0.1:4310`.

**Pin to taskbar:** Start → type `Grok UI` → right-click → **Pin to taskbar**.

## Logs and state

| Path | Contents |
| --- | --- |
| `%USERPROFILE%\.grok-ui\logs\service.log` | Supervisor lifecycle |
| `%USERPROFILE%\.grok-ui\logs\server-stdout.log` | Last server stdout |
| `%USERPROFILE%\.grok-ui\logs\server-stderr.log` | Last server stderr |
| `%USERPROFILE%\.grok-ui\package-root.txt` | Package root remembered at install time |

## Uninstall

```powershell
powershell -ExecutionPolicy Bypass -File "$env:APPDATA\npm\node_modules\grok-ui\scripts\windows\Uninstall-DesktopLauncher.ps1"
```

Remove copied stubs (keep logs):

```powershell
... Uninstall-DesktopLauncher.ps1 -RemoveState
```

Remove stubs and logs:

```powershell
... Uninstall-DesktopLauncher.ps1 -RemoveState -RemoveLogs
```

This does **not** uninstall the npm package or touch `~/.grok` session history.

## Manual controls

```powershell
# Start / stop the supervisor task
Start-ScheduledTask -TaskName GrokUI
Stop-ScheduledTask -TaskName GrokUI

# Open the dashboard only (starts if needed)
powershell -ExecutionPolicy Bypass -File "$env:USERPROFILE\.grok-ui\Start-GrokUI.ps1"
```

## Design notes

- **Why a Scheduled Task?** Processes started from agent shells or some IDE terminals often run inside a Windows job object that kills children when the parent ends. The task runs outside that tree.
- **Why copy scripts to `~\.grok-ui`?** Global npm paths change across installs; a stable path keeps the task registration valid.
- **Why an `.exe` stub?** Shortcuts that target `powershell.exe` pin poorly. A tiny WinForms host that launches the start script pins as its own app.
- **Security:** Still binds loopback by default. Remote binds still require `GROK_UI_TOKEN` as documented in [SECURITY.md](../SECURITY.md).
