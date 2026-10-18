LangString MaiWelcomeTitle ${LANG_SIMPCHINESE} "安装 MaiBot OneKey"
LangString MaiWelcomeText ${LANG_SIMPCHINESE} "选择安装位置，即可开始安装。"
LangString MaiFinishTitle ${LANG_SIMPCHINESE} "安装完成"
LangString MaiFinishText ${LANG_SIMPCHINESE} "MaiBot OneKey 已安装完成。$\r$\n$\r$\n启动后，就可以继续配置你的麦麦。"
LangString MaiDirectoryTitle ${LANG_SIMPCHINESE} "安装位置"
LangString MaiDirectoryHint ${LANG_SIMPCHINESE} "选择文件夹，然后点击“安装”。"
LangString MaiDirectoryBrowse ${LANG_SIMPCHINESE} "更改…"
LangString MaiWelcomeTitle ${LANG_ENGLISH} "Install MaiBot OneKey"
LangString MaiWelcomeText ${LANG_ENGLISH} "Choose a location to begin installation."
LangString MaiFinishTitle ${LANG_ENGLISH} "Installation complete"
LangString MaiFinishText ${LANG_ENGLISH} "MaiBot OneKey is installed.$\r$\n$\r$\nLaunch the app to set up your bot."
LangString MaiDirectoryTitle ${LANG_ENGLISH} "Install location"
LangString MaiDirectoryHint ${LANG_ENGLISH} "Choose a folder, then click Install."
LangString MaiDirectoryBrowse ${LANG_ENGLISH} "Change…"

Function MaiGuiInit
  InitPluginsDir
  File "/oname=$PLUGINSDIR\millennium.dll" "${BUILD_RESOURCES_DIR}\..\.codex-tmp\installer-ui\millennium.dll"
  StrCpy $0 0
  System::Call '$PLUGINSDIR\millennium.dll::Initialize(p $HWNDPARENT, w "v${VERSION}", i $LANGUAGE) i.r0 ?c'
  ${If} $0 != 1
    MessageBox MB_OK|MB_ICONSTOP "Unable to initialize the MaiBot installer interface."
    Quit
  ${EndIf}
FunctionEnd
Function .onGUIEnd
  System::Call '$PLUGINSDIR\millennium.dll::Shutdown() ?c'
FunctionEnd
Function MaiWelcomePre
  ${if} ${isUpdated}
    Abort
  ${endif}
FunctionEnd
; NSIS can keep several #32770 child dialogs alive during navigation. Use each
; page's actual handle, including when it is recreated by the Back button.
!macro MaiStylePage NAME PAGE PHASE
Function ${NAME}
  System::Call '$PLUGINSDIR\millennium.dll::StylePage(p $HWNDPARENT, p ${PAGE}, i ${PHASE}) ?c'
FunctionEnd
!macroend
!insertmacro MaiStylePage MaiWelcomeShow $mui.WelcomePage 0
!insertmacro MaiStylePage MaiModeShow $MultiUser.InstallModePage 1
Function MaiDirectoryShow
  SendMessage $mui.Header.Text ${WM_SETTEXT} 0 "STR:$(MaiDirectoryTitle)"
  SendMessage $mui.Header.SubText ${WM_SETTEXT} 0 "STR:$(MaiDirectoryHint)"
  SendMessage $mui.DirectoryPage.BrowseButton ${WM_SETTEXT} 0 "STR:$(MaiDirectoryBrowse)"
  System::Call '$PLUGINSDIR\millennium.dll::StylePage(p $HWNDPARENT, p $mui.DirectoryPage, i 2) ?c'
FunctionEnd
!insertmacro MaiStylePage MaiProgressShow $mui.InstFilesPage 3
!insertmacro MaiStylePage MaiFinishShow $mui.FinishPage 4
