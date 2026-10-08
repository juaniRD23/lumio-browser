; Lumio Browser's Windows setup: installs for this Windows user (no admin
; prompt), like Chrome, into %LOCALAPPDATA%\Programs\Lumio Browser, with Start
; menu and desktop shortcuts, an entry in Apps & features, and the registry
; entries that let Windows offer Lumio Browser as a web browser (Settings >
; Default apps). The updater runs it with /S. Your bookmarks, passwords and
; settings live in %APPDATA%\Lumio Browser and are kept.
;
; Built by build/windows.mjs:
;   makensis /DVERSION=1.2.3 /DSOURCE=<packaged app folder> /DOUTFILE=<setup.exe> /DICON=<icon.ico> installer.nsi
Unicode true
ManifestDPIAware true
!include "MUI2.nsh"
!include "FileFunc.nsh"
!include "LogicLib.nsh"

!define APP "Lumio Browser"
!define EXE "Lumio Browser.exe"
!define UNINSTALLER "Uninstall Lumio Browser.exe"
!define APP_ID "online.lumio-usa.browser"
!define PROGID "LumioHTML"
!define CLIENT "LumioBrowser"
!define UNINSTALL_KEY "Software\Microsoft\Windows\CurrentVersion\Uninstall\LumioBrowser"
!define CLIENT_KEY "Software\Clients\StartMenuInternet\${CLIENT}"

Name "${APP}"
OutFile "${OUTFILE}"
InstallDir "$LOCALAPPDATA\Programs\Lumio Browser"
RequestExecutionLevel user
SetCompressor /SOLID lzma
BrandingText "${APP} ${VERSION}"
VIProductVersion "${VERSION}.0"
VIAddVersionKey "ProductName" "${APP}"
VIAddVersionKey "ProductVersion" "${VERSION}"
VIAddVersionKey "FileVersion" "${VERSION}"
VIAddVersionKey "FileDescription" "${APP} Setup"
VIAddVersionKey "CompanyName" "Lumio"
VIAddVersionKey "LegalCopyright" "(c) Lumio"

!define MUI_ICON "${ICON}"
!define MUI_UNICON "${ICON}"
!define MUI_ABORTWARNING
!define MUI_FINISHPAGE_RUN "$INSTDIR\${EXE}"
!define MUI_FINISHPAGE_RUN_TEXT "Open Lumio Browser"
!insertmacro MUI_PAGE_INSTFILES
!insertmacro MUI_PAGE_FINISH
!insertmacro MUI_UNPAGE_CONFIRM
!insertmacro MUI_UNPAGE_INSTFILES
!insertmacro MUI_LANGUAGE "English"

; Lumio has to be closed for its files to be replaced or removed.
!macro CloseLumio
  nsExec::ExecToStack 'cmd /c tasklist /FI "IMAGENAME eq ${EXE}" /NH | find /I "${EXE}"'
  Pop $0
  Pop $1
  ${If} $0 == 0
    ${IfNot} ${Silent}
      MessageBox MB_OKCANCEL|MB_ICONINFORMATION "Lumio Browser is open. Click OK to close it and continue." IDOK +2
      Abort
    ${EndIf}
    nsExec::Exec 'taskkill /IM "${EXE}" /T'
    Sleep 2500
    nsExec::Exec 'taskkill /IM "${EXE}" /T /F'
    Sleep 800
  ${EndIf}
!macroend

Section "Install"
  !insertmacro CloseLumio
  SetOutPath "$INSTDIR"
  ; The app's own files (the person's data is in AppData\Roaming).
  RMDir /r "$INSTDIR\resources"
  RMDir /r "$INSTDIR\locales"
  File /r "${SOURCE}\*.*"
  WriteUninstaller "$INSTDIR\${UNINSTALLER}"

  ; Shortcuts. Lumio adds its app ID to the Start menu one on first launch
  ; (Windows shows notifications only for apps with one).
  CreateShortCut "$SMPROGRAMS\${APP}.lnk" "$INSTDIR\${EXE}" "" "$INSTDIR\${EXE}" 0
  ${IfNot} ${Silent}
    CreateShortCut "$DESKTOP\${APP}.lnk" "$INSTDIR\${EXE}" "" "$INSTDIR\${EXE}" 0
  ${EndIf}

  ; Apps & features.
  WriteRegStr HKCU "${UNINSTALL_KEY}" "DisplayName" "${APP}"
  WriteRegStr HKCU "${UNINSTALL_KEY}" "DisplayVersion" "${VERSION}"
  WriteRegStr HKCU "${UNINSTALL_KEY}" "Publisher" "Lumio"
  WriteRegStr HKCU "${UNINSTALL_KEY}" "DisplayIcon" "$INSTDIR\${EXE},0"
  WriteRegStr HKCU "${UNINSTALL_KEY}" "InstallLocation" "$INSTDIR"
  WriteRegStr HKCU "${UNINSTALL_KEY}" "UninstallString" '"$INSTDIR\${UNINSTALLER}"'
  WriteRegStr HKCU "${UNINSTALL_KEY}" "QuietUninstallString" '"$INSTDIR\${UNINSTALLER}" /S'
  WriteRegStr HKCU "${UNINSTALL_KEY}" "URLInfoAbout" "https://lumio-co.online"
  WriteRegDWORD HKCU "${UNINSTALL_KEY}" "NoModify" 1
  WriteRegDWORD HKCU "${UNINSTALL_KEY}" "NoRepair" 1
  ${GetSize} "$INSTDIR" "/S=0K" $0 $1 $2
  IntFmt $0 "0x%08X" $0
  WriteRegDWORD HKCU "${UNINSTALL_KEY}" "EstimatedSize" "$0"

  ; A web browser Windows can offer (Settings > Default apps > Web browser).
  WriteRegStr HKCU "Software\Classes\${PROGID}" "" "Lumio HTML Document"
  WriteRegStr HKCU "Software\Classes\${PROGID}" "URL Protocol" ""
  WriteRegStr HKCU "Software\Classes\${PROGID}\Application" "ApplicationName" "${APP}"
  WriteRegStr HKCU "Software\Classes\${PROGID}\Application" "ApplicationIcon" "$INSTDIR\${EXE},0"
  WriteRegStr HKCU "Software\Classes\${PROGID}\Application" "AppUserModelId" "${APP_ID}"
  WriteRegStr HKCU "Software\Classes\${PROGID}\DefaultIcon" "" "$INSTDIR\${EXE},0"
  WriteRegStr HKCU "Software\Classes\${PROGID}\shell\open\command" "" '"$INSTDIR\${EXE}" "%1"'
  WriteRegStr HKCU "${CLIENT_KEY}" "" "${APP}"
  WriteRegStr HKCU "${CLIENT_KEY}\DefaultIcon" "" "$INSTDIR\${EXE},0"
  WriteRegStr HKCU "${CLIENT_KEY}\shell\open\command" "" '"$INSTDIR\${EXE}"'
  WriteRegStr HKCU "${CLIENT_KEY}\Capabilities" "ApplicationName" "${APP}"
  WriteRegStr HKCU "${CLIENT_KEY}\Capabilities" "ApplicationDescription" "The browser that does the work, with Lumio AI."
  WriteRegStr HKCU "${CLIENT_KEY}\Capabilities" "ApplicationIcon" "$INSTDIR\${EXE},0"
  WriteRegStr HKCU "${CLIENT_KEY}\Capabilities\StartMenu" "StartMenuInternet" "${CLIENT}"
  WriteRegStr HKCU "${CLIENT_KEY}\Capabilities\URLAssociations" "http" "${PROGID}"
  WriteRegStr HKCU "${CLIENT_KEY}\Capabilities\URLAssociations" "https" "${PROGID}"
  WriteRegStr HKCU "${CLIENT_KEY}\Capabilities\FileAssociations" ".htm" "${PROGID}"
  WriteRegStr HKCU "${CLIENT_KEY}\Capabilities\FileAssociations" ".html" "${PROGID}"
  WriteRegStr HKCU "${CLIENT_KEY}\Capabilities\FileAssociations" ".xhtml" "${PROGID}"
  WriteRegStr HKCU "${CLIENT_KEY}\Capabilities\FileAssociations" ".pdf" "${PROGID}"
  WriteRegStr HKCU "${CLIENT_KEY}\Capabilities\FileAssociations" ".svg" "${PROGID}"
  WriteRegStr HKCU "${CLIENT_KEY}\Capabilities\FileAssociations" ".webp" "${PROGID}"
  WriteRegStr HKCU "Software\RegisteredApplications" "${APP}" "${CLIENT_KEY}\Capabilities"
  ; Tell Explorer the associations changed.
  System::Call 'shell32::SHChangeNotify(i 0x08000000, i 0, p 0, p 0)'
SectionEnd

Section "Uninstall"
  !insertmacro CloseLumio
  Delete "$SMPROGRAMS\${APP}.lnk"
  Delete "$DESKTOP\${APP}.lnk"
  ; Only the folder Lumio was installed in (never a folder without Lumio in it).
  ${If} ${FileExists} "$INSTDIR\${EXE}"
    RMDir /r "$INSTDIR"
  ${EndIf}
  DeleteRegKey HKCU "${UNINSTALL_KEY}"
  DeleteRegKey HKCU "${CLIENT_KEY}"
  DeleteRegKey HKCU "Software\Classes\${PROGID}"
  DeleteRegValue HKCU "Software\RegisteredApplications" "${APP}"
  System::Call 'shell32::SHChangeNotify(i 0x08000000, i 0, p 0, p 0)'
SectionEnd
