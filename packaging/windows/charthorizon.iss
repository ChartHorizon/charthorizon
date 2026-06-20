; dashboard/packaging/windows/charthorizon.iss
#define MyVersion GetEnv("CHARTHORIZON_VERSION")

[Setup]
AppName=ChartHorizon
AppVersion={#MyVersion}
DefaultDirName={localappdata}\ChartHorizon
PrivilegesRequired=lowest
DisableProgramGroupPage=yes
OutputDir=..\..\dist
OutputBaseFilename=ChartHorizon-{#MyVersion}-Windows-Setup
SetupIconFile=..\icons\icon.ico
Compression=lzma2
SolidCompression=yes

[Files]
Source: "..\..\dist\ChartHorizon\*"; DestDir: "{app}"; Flags: recursesubdirs ignoreversion

[Icons]
Name: "{userprograms}\ChartHorizon"; Filename: "{app}\ChartHorizon.exe"
Name: "{userdesktop}\ChartHorizon"; Filename: "{app}\ChartHorizon.exe"

[Run]
Filename: "{app}\ChartHorizon.exe"; Description: "Launch ChartHorizon"; Flags: nowait postinstall skipifsilent
