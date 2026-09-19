# dashboard/packaging/windows/build_win.ps1
# ASCII ONLY. Windows PowerShell 5.1 reads a BOM-less .ps1 as the ANSI code page, so a
# UTF-8 em-dash arrives as three cp1252 characters -- one of them a double quote, which
# ends the string mid-sentence and takes the whole parse down with it.
param([Parameter(Mandatory=$true)][string]$Version)
$ErrorActionPreference = "Stop"
Set-Location (Join-Path $PSScriptRoot "..\..")     # -> dashboard/

# $ErrorActionPreference does NOT cover native executables: PyInstaller or ISCC can fail
# and the script would sail past it and print "Built ...". Every external call below is
# followed by this.
function Assert-LastExitOk($what) {
    if ($LASTEXITCODE -ne 0) { throw "$what failed with exit code $LASTEXITCODE" }
}

# ---- Guard 1: the interpreter must be the emulated x64 one ------------------------
# PyInstaller freezes whatever interpreter it runs under. On the Windows-11-ARM build VM
# an ARM64 Python silently produces an ARM64 .exe that no user's machine can run. Ask
# sysconfig, never platform.machine() -- that reports the MACHINE and says ARM64 even when
# the right Python is running.
$rawTarget = python -c "import sysconfig; print(sysconfig.get_platform())"
Assert-LastExitOk "python"
$target = ($rawTarget | Select-Object -Last 1).Trim()
if ($target -ne "win-amd64") {
    throw ("Wrong interpreter: sysconfig.get_platform() = '$target', need 'win-amd64'. " +
           "This is the ARM64 Python; use the emulated x64 one.")
}

# ---- Guard 2: the source must be the version being built --------------------------
# The VM builds from its own copy (C:\ch), not a live share, and the installer's NAME
# comes from $Version alone -- so a stale copy yields an .exe called 1.2.3 that reports
# the previous version and still carries the previous code. That cost two rebuilds on
# 2026-08-30; it is one file read to make it impossible.
$rawDeclared = python -c "import sys; sys.path.insert(0, 'app'); import app_version; print(app_version.APP_VERSION)"
Assert-LastExitOk "python"
$declared = ($rawDeclared | Select-Object -Last 1).Trim()
if ($declared -ne $Version) {
    throw ("Version mismatch: app/app_version.py says '$declared', building '$Version'. " +
           "The source copy is stale -- re-run the robocopy from the Mac share first.")
}
# ---- Guard 3: the documents the installer conveys must be there -------------------
# The installer compiles RISK-NOTICE.txt in as its licence page and drops both files next
# to the .exe, and the spec puts both inside the bundle. LICENSE sits at the dashboard
# ROOT -- one level above the two trees the VM mirrors -- so it needs a copy of its own:
#     robocopy \\Mac\Home\charthorizon\dashboard C:\ch LICENSE
# Unguarded, a missing LICENSE fails inside PyInstaller's datas minutes in, with an error
# that names a path and not the fix.
foreach ($doc in @("LICENSE", "packaging\public\RISK-NOTICE.txt")) {
    if (-not (Test-Path $doc)) {
        throw ("Missing $doc -- the installer conveys it with the binary. Copy it over " +
               "(robocopy \\Mac\Home\charthorizon\dashboard C:\ch LICENSE for the licence, " +
               "or re-run the packaging robocopy) and rebuild.")
    }
}

Write-Host "Building ChartHorizon $Version  (interpreter: $target)"

python packaging\build_icons.py
Assert-LastExitOk "build_icons.py"
python -m PyInstaller packaging\charthorizon.spec --noconfirm --clean
Assert-LastExitOk "PyInstaller"

# ---- Guard 4: the frozen .exe must actually be x64 --------------------------------
# Read the PE machine field off the PyInstaller output, NOT off the -Setup.exe: that
# stub is Inno Setup's own and always reports 0x014C (i386) no matter what it wraps.
$exe = "dist\ChartHorizon\ChartHorizon.exe"
if (-not (Test-Path $exe)) { throw "PyInstaller produced no $exe" }
$fs = [System.IO.File]::OpenRead((Resolve-Path $exe).Path)
try {
    $br = New-Object System.IO.BinaryReader($fs)
    $fs.Position = 0x3C
    $fs.Position = $br.ReadInt32()      # e_lfanew -> PE signature
    $br.ReadUInt32() | Out-Null         # "PE\0\0"
    $machine = $br.ReadUInt16()
} finally { $fs.Close() }
if ($machine -ne 0x8664) {
    throw ("Wrong architecture: {0} has PE machine 0x{1:X4}, need 0x8664 (x64)." -f $exe, $machine)
}

$env:CHARTHORIZON_VERSION = $Version
& "${env:ProgramFiles(x86)}\Inno Setup 6\ISCC.exe" packaging\windows\charthorizon.iss
Assert-LastExitOk "Inno Setup (ISCC)"

$setup = "dist\ChartHorizon-$Version-Windows-Setup.exe"
if (-not (Test-Path $setup)) { throw "Inno Setup reported success but $setup is not there" }
Write-Host ("Built {0} ({1:N1} MiB)" -f $setup, ((Get-Item $setup).Length / 1MB))
