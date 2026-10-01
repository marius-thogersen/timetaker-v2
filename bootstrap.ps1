<#
  One-command installer for TimeTaker v2.

  Run this from PowerShell on the race PC:
    irm https://raw.githubusercontent.com/marius-thogersen/timetaker-v2/main/bootstrap.ps1 | iex

  By default it installs to "Desktop\TimeTaker". It downloads the app,
  installs Node.js/Python if needed, and adds two Desktop shortcuts to start
  it.

  To choose a different install location, either:
    - run it with a parameter:
        .\bootstrap.ps1 -InstallPath "D:\Race\TimeTaker"
    - or, when using the one-liner above (which can't take parameters
      directly), set an environment variable first:
        $env:TIMETAKER_INSTALL_PATH = "D:\Race\TimeTaker"
        irm https://raw.githubusercontent.com/marius-thogersen/timetaker-v2/main/bootstrap.ps1 | iex
  If neither is given, you'll be asked where to install (press Enter to
  accept the default).
#>

param(
    [string]$InstallPath
)

$ErrorActionPreference = 'Stop'

# NOTE: update owner/repo here if this project is pushed under a different
# GitHub account or repository name.
$repoZipUrl = 'https://github.com/marius-thogersen/timetaker-v2/archive/refs/heads/main.zip'
$defaultInstallRoot = Join-Path $env:USERPROFILE 'Desktop\TimeTaker'

Write-Host '=== TimeTaker v2: download & install ===' -ForegroundColor Yellow

if (-not $InstallPath) { $InstallPath = $env:TIMETAKER_INSTALL_PATH }

if (-not $InstallPath) {
    $response = Read-Host "Where should TimeTaker be installed? (press Enter for $defaultInstallRoot)"
    $InstallPath = if ([string]::IsNullOrWhiteSpace($response)) { $defaultInstallRoot } else { $response.Trim() }
}

# The app stores race results next to itself, so it needs a writable,
# non-system location.
$protectedFolders = @($env:ProgramFiles, ${env:ProgramFiles(x86)}, $env:SystemRoot) | Where-Object { $_ }
if ($protectedFolders | Where-Object { $InstallPath.StartsWith($_, [StringComparison]::OrdinalIgnoreCase) }) {
    throw "TimeTaker can't be installed inside $InstallPath because it stores race results in its own folder. Choose somewhere like Desktop or Documents instead."
}

$installRoot = $InstallPath
Write-Host "Installing to $installRoot" -ForegroundColor Cyan

$tempZip = Join-Path $env:TEMP "timetaker-v2-$([Guid]::NewGuid()).zip"
$tempExtract = Join-Path $env:TEMP "timetaker-v2-$([Guid]::NewGuid())"

Write-Host 'Downloading...' -ForegroundColor Cyan
Invoke-WebRequest -Uri $repoZipUrl -OutFile $tempZip

Write-Host 'Unpacking...' -ForegroundColor Cyan
Expand-Archive -Path $tempZip -DestinationPath $tempExtract -Force
$extractedFolder = Get-ChildItem $tempExtract -Directory | Select-Object -First 1

if (Test-Path $installRoot) {
    Write-Host "TimeTaker already exists at $installRoot, updating (keeping saved race data)..." -ForegroundColor Cyan
    Get-ChildItem $installRoot -Exclude 'data' | Remove-Item -Recurse -Force
} else {
    New-Item -ItemType Directory -Path $installRoot -Force | Out-Null
}

Copy-Item "$($extractedFolder.FullName)\*" $installRoot -Recurse -Force

Remove-Item $tempZip -Force -ErrorAction SilentlyContinue
Remove-Item $tempExtract -Recurse -Force -ErrorAction SilentlyContinue

# Clears the "downloaded from the internet" flag so Windows stops warning.
Get-ChildItem $installRoot -Recurse -File | Unblock-File -ErrorAction SilentlyContinue

Write-Host ''
Write-Host "Installed to $installRoot" -ForegroundColor Green
& "$installRoot\install.ps1"

Write-Host ''
Write-Host 'Adding Desktop shortcuts...' -ForegroundColor Cyan
$shell = New-Object -ComObject WScript.Shell
$desktop = [Environment]::GetFolderPath('Desktop')

$startShortcut = $shell.CreateShortcut((Join-Path $desktop 'TimeTaker.lnk'))
$startShortcut.TargetPath = Join-Path $installRoot 'Start.cmd'
$startShortcut.WorkingDirectory = $installRoot
$startShortcut.Description = 'Start TimeTaker'
$startShortcut.Save()

$readerShortcut = $shell.CreateShortcut((Join-Path $desktop 'TimeTaker RFID Reader.lnk'))
$readerShortcut.TargetPath = Join-Path $installRoot 'Start-RFID-Reader.cmd'
$readerShortcut.WorkingDirectory = $installRoot
$readerShortcut.Description = 'Start the RFID reader'
$readerShortcut.Save()

Write-Host ''
Write-Host '=== Done ===' -ForegroundColor Green
Write-Host 'Two shortcuts were added to your Desktop: "TimeTaker" and "TimeTaker RFID Reader".'
