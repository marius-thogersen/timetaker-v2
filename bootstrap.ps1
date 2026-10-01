<#
  One-command installer for TimeTaker v2.

  Run this from PowerShell on the race PC:
    irm https://raw.githubusercontent.com/marius-thogersen/timetaker-v2/main/bootstrap.ps1 | iex

  It downloads the app, unpacks it to your Desktop, installs Node.js/Python if
  needed, and adds two Desktop shortcuts to start it.
#>

$ErrorActionPreference = 'Stop'

# NOTE: update owner/repo here if this project is pushed under a different
# GitHub account or repository name.
$repoZipUrl = 'https://github.com/marius-thogersen/timetaker-v2/archive/refs/heads/main.zip'
$installRoot = Join-Path $env:USERPROFILE 'Desktop\TimeTaker'

Write-Host '=== TimeTaker v2: download & install ===' -ForegroundColor Yellow

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
