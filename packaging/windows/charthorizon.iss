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
; The risk notice, on the wizard page that cannot be walked past unread: Inno disables
; Next until "I have read and accept" is selected. RISK-NOTICE.txt is pure ASCII on
; purpose -- Inno reads a BOM-less .txt as the ANSI code page, so a UTF-8 dash would
; arrive as mojibake in the middle of a legal sentence (the same trap build_win.ps1
; carries a comment about).
LicenseFile=..\public\RISK-NOTICE.txt
Compression=lzma2
SolidCompression=yes

[Files]
Source: "..\..\dist\ChartHorizon\*"; DestDir: "{app}"; Flags: recursesubdirs ignoreversion
; Both also ride inside the bundle (charthorizon.spec datas), where APP_DIR can serve
; them; these two lines are what puts them where a user can actually find them, next
; to the .exe. The AGPL is conveyed WITH the binary, not only linked from it.
Source: "..\public\RISK-NOTICE.txt"; DestDir: "{app}"; Flags: ignoreversion
Source: "..\..\LICENSE"; DestDir: "{app}"; DestName: "LICENSE.txt"; Flags: ignoreversion

[Icons]
Name: "{userprograms}\ChartHorizon"; Filename: "{app}\ChartHorizon.exe"
Name: "{userdesktop}\ChartHorizon"; Filename: "{app}\ChartHorizon.exe"

[Run]
Filename: "{app}\ChartHorizon.exe"; Description: "Launch ChartHorizon"; Flags: nowait postinstall skipifsilent

[Messages]
WizardLicense=Risk notice
LicenseLabel=Please read this before installing ChartHorizon.
LicenseLabel3=ChartHorizon is an educational tool, not investment advice, and trading carries a substantial risk of loss. Please read the notice below; you must confirm that you have read it before the installation can continue.
LicenseAccepted=I have read and &accept this notice
LicenseNotAccepted=I do &not accept this notice
