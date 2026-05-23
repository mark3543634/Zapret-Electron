[Setup]
AppName=Zapret Electron
AppVersion=5.9
AppPublisher=ZapretPro
AppId={{A1B2C3D4-E5F6-7890-ABCD-EF1234567890}
DefaultDirName={autopf}\ZapretPro
DefaultGroupName=Zapret Electron
OutputDir=.\releases
OutputBaseFilename=ZapretPro-Setup-v5.9
Compression=lzma2/ultra64
SolidCompression=yes
PrivilegesRequired=admin
UninstallDisplayIcon={app}\ZapretPro.exe
WizardStyle=modern
CloseApplications=yes
CloseApplicationsFilter=*.exe

[Languages]
Name: "russian"; MessagesFile: "compiler:Languages\Russian.isl"

[Files]
Source: "ZapretPro-win32-x64\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs

[Icons]
Name: "{group}\Zapret Electron"; Filename: "{app}\ZapretPro.exe"
Name: "{commondesktop}\Zapret Electron"; Filename: "{app}\ZapretPro.exe"

[Run]
Filename: "{app}\ZapretPro.exe"; Description: "Запустить Zapret Electron"; Flags: nowait postinstall skipifsilent

[UninstallDelete]
Type: filesandordirs; Name: "{app}"

[Code]
function InitializeSetup(): Boolean;
var
  UninstallStr: String;
  ResultCode: Integer;
begin
  Result := True;
  if RegQueryStringValue(HKLM, 'Software\Microsoft\Windows\CurrentVersion\Uninstall\{A1B2C3D4-E5F6-7890-ABCD-EF1234567890}_is1', 'UninstallString', UninstallStr) then
  begin
    UninstallStr := RemoveQuotes(UninstallStr);
    Exec(UninstallStr, '/SILENT /NORESTART /SUPPRESSMSGBOXES', '', SW_HIDE, ewWaitUntilTerminated, ResultCode);
  end;
end;
