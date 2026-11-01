; AIQ 安装脚本（自己写的，绕开 electron-builder 的安装包自检）
; 关键点：快捷方式带 --no-sandbox，装完直接启动，用户不用碰参数。

Unicode true
!include "MUI2.nsh"

Name "AIQ"
OutFile "..\dist\AIQ-Setup-0.1.0b.exe"
InstallDir "$LOCALAPPDATA\Programs\AIQ"
InstallDirRegKey HKCU "Software\AIQ" "InstallDir"
RequestExecutionLevel user
SetCompressor lzma
ShowInstDetails hide

!define MUI_ABORTWARNING
!define MUI_FINISHPAGE_RUN "$INSTDIR\AIQ.exe"
!define MUI_FINISHPAGE_RUN_PARAMETERS "--no-sandbox"
!define MUI_FINISHPAGE_RUN_TEXT "立即启动 AIQ"

!insertmacro MUI_PAGE_WELCOME
!insertmacro MUI_PAGE_INSTFILES
!insertmacro MUI_PAGE_FINISH
!insertmacro MUI_UNPAGE_CONFIRM
!insertmacro MUI_UNPAGE_INSTFILES
!insertmacro MUI_LANGUAGE "SimpChinese"

Section "Install"
  SetOutPath "$INSTDIR"
  File /r "..\dist\win-unpacked\*.*"

  CreateShortCut "$DESKTOP\AIQ.lnk" "$INSTDIR\AIQ.exe" "--no-sandbox" "$INSTDIR\AIQ.exe" 0
  CreateShortCut "$SMPROGRAMS\AIQ.lnk" "$INSTDIR\AIQ.exe" "--no-sandbox" "$INSTDIR\AIQ.exe" 0

  WriteRegStr HKCU "Software\AIQ" "InstallDir" "$INSTDIR"
  WriteUninstaller "$INSTDIR\Uninstall.exe"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\AIQ" "DisplayName" "AIQ"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\AIQ" "UninstallString" "$INSTDIR\Uninstall.exe"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\AIQ" "DisplayVersion" "0.1.0"
SectionEnd

Section "Uninstall"
  Delete "$DESKTOP\AIQ.lnk"
  Delete "$SMPROGRAMS\AIQ.lnk"
  RMDir /r "$INSTDIR"
  DeleteRegKey HKCU "Software\AIQ"
  DeleteRegKey HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\AIQ"
SectionEnd
