; 自定义 NSIS 片段：安装时建带 --no-sandbox 参数的快捷方式
; 这台机器（以及部分 Win11 机器）上 Electron 沙箱会让主进程直接崩，
; 所以快捷方式必须带 --no-sandbox；用户只管双击图标，不用自己配参数。

!macro customInstall
  CreateShortCut "$DESKTOP\AIQ.lnk" "$INSTDIR\AIQ.exe" "--no-sandbox"
  CreateShortCut "$SMPROGRAMS\AIQ.lnk" "$INSTDIR\AIQ.exe" "--no-sandbox"
!macroend

!macro customUnInstall
  Delete "$DESKTOP\AIQ.lnk"
  Delete "$SMPROGRAMS\AIQ.lnk"
!macroend
