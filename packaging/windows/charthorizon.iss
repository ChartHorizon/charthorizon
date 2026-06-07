; Inno Setup script — per-user install (no admin). Compiled by ISCC.exe in CI.
; Expects the PyInstaller onedir output at dist\ChartHorizon\
[Setup]
AppName=ChartHorizon
AppVersion=1.0.2
DefaultDirName={localappdata}\ChartHorizon
DefaultGroupName=ChartHorizon
PrivilegesRequired=lowest
OutputDir=..\..\dist
OutputBaseFilename=ChartHorizon-Windows-Setup
Compression=lzma2
SolidCompression=yes
DisableProgramGroupPage=yes
SetupIconFile=..\icons\charthorizon.ico
UninstallDisplayIcon={app}\ChartHorizon.exe

[Files]
Source: "..\..\dist\ChartHorizon\*"; DestDir: "{app}"; Flags: recursesubdirs createallsubdirs

[Icons]
Name: "{group}\ChartHorizon"; Filename: "{app}\ChartHorizon.exe"
Name: "{userdesktop}\ChartHorizon"; Filename: "{app}\ChartHorizon.exe"

[Run]
Filename: "{app}\ChartHorizon.exe"; Description: "Launch ChartHorizon"; Flags: nowait postinstall skipifsilent
