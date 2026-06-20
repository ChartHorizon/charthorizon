# dashboard/packaging/windows/build_win.ps1
param([Parameter(Mandatory=$true)][string]$Version)
$ErrorActionPreference = "Stop"
Set-Location (Join-Path $PSScriptRoot "..\..")     # -> dashboard/
python packaging\build_icons.py
python -m PyInstaller packaging\charthorizon.spec --noconfirm --clean
$env:CHARTHORIZON_VERSION = $Version
& "${env:ProgramFiles(x86)}\Inno Setup 6\ISCC.exe" packaging\windows\charthorizon.iss
Write-Host "Built dist/ChartHorizon-$Version-Windows-Setup.exe"
