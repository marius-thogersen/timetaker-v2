<#
  Sets up a Windows 11 PC to run TimeTaker v2: makes sure Node.js and Python
  are installed, then installs the RFID reader's Python dependencies.

  Run this once after downloading/cloning the repo:
      powershell -ExecutionPolicy Bypass -File install.ps1
#>

$ErrorActionPreference = 'Stop'

function Test-Command {
    param([string]$Name)
    return [bool](Get-Command $Name -ErrorAction SilentlyContinue)
}

function Install-WithWinget {
    param([string]$Id, [string]$FriendlyName)

    if (-not (Test-Command 'winget')) {
        throw "winget is not available. Please install $FriendlyName manually from its website, then re-run this script."
    }

    Write-Host "Installing $FriendlyName via winget..." -ForegroundColor Cyan
    winget install --id $Id -e --silent --accept-package-agreements --accept-source-agreements
}

Write-Host '=== TimeTaker v2: setup ===' -ForegroundColor Yellow

# --- Node.js (runs server\server.js, no external packages needed) ----------
if (Test-Command 'node') {
    Write-Host "Node.js found: $(node --version)" -ForegroundColor Green
} else {
    Install-WithWinget -Id 'OpenJS.NodeJS.LTS' -FriendlyName 'Node.js'
}

# --- Python (runs the RFID reader) ------------------------------------------
if (Test-Command 'py') {
    Write-Host "Python found: $(py --version)" -ForegroundColor Green
} else {
    Install-WithWinget -Id 'Python.Python.3.12' -FriendlyName 'Python'
}

Write-Host ''
Write-Host 'Refreshing PATH for this session...' -ForegroundColor Cyan
$machinePath = [Environment]::GetEnvironmentVariable('Path', 'Machine')
$userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
$env:Path = "$machinePath;$userPath"

Write-Host ''
Write-Host 'Installing RFID reader dependencies...' -ForegroundColor Cyan
py -m pip install --quiet -r "$PSScriptRoot\rfid-reader\requirements.txt"

Write-Host ''
Write-Host '=== Setup complete ===' -ForegroundColor Green
Write-Host 'Double-click Start.cmd to open TimeTaker.'
Write-Host 'Double-click Start-RFID-Reader.cmd on the scanning PC to start reading chips.'
Write-Host ''
Write-Host 'Note: the RFID reader reads keystrokes system-wide, so Windows may ask you' -ForegroundColor DarkYellow
Write-Host 'to "Run as administrator" the first time you start it.' -ForegroundColor DarkYellow
