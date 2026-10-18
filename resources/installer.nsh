; Native Millennium presentation; electron-builder still owns installation.
!ifndef BUILD_UNINSTALLER
  !define MAIBOT_MILLENNIUM_INSTALLER
  !define MUI_CUSTOMFUNCTION_GUIINIT MaiGuiInit
!endif
!macro customHeader
  SetFont "Microsoft YaHei UI" 9
  ShowInstDetails hide
  !ifdef BUILD_UNINSTALLER
    ShowUninstDetails hide
  !else
    !include "${BUILD_RESOURCES_DIR}\installer\pages.nsh"
  !endif
!macroend

!ifndef BUILD_UNINSTALLER
!macro customWelcomePage
  !define MUI_WELCOMEPAGE_TITLE "$(MaiWelcomeTitle)"
  !define MUI_WELCOMEPAGE_TEXT "$(MaiWelcomeText)"
  !define MUI_PAGE_CUSTOMFUNCTION_PRE MaiWelcomePre
  !define MUI_PAGE_CUSTOMFUNCTION_SHOW MaiWelcomeShow
  !insertmacro MUI_PAGE_WELCOME
  ; Consumed by the existing installation-mode page.
  !define MUI_PAGE_CUSTOMFUNCTION_SHOW MaiModeShow
!macroend
!macro customPageAfterChangeDir
  ; Leave the existing instFilesPre directory normalization intact.
  ShowInstDetails hide
  !define MUI_PAGE_CUSTOMFUNCTION_SHOW MaiProgressShow
!macroend
!macro customFinishPage
  !ifndef HIDE_RUN_AFTER_FINISH
    Function StartApp
      ${if} ${isUpdated}
        StrCpy $1 "--updated"
      ${else}
        StrCpy $1 ""
      ${endif}
      HideWindow
      ${StdUtils.ExecShellAsUser} $0 "$launchLink" "open" "$1"
    FunctionEnd
    !define MUI_FINISHPAGE_RUN
    !define MUI_FINISHPAGE_RUN_FUNCTION "StartApp"
  !endif
  !define MUI_FINISHPAGE_TITLE "$(MaiFinishTitle)"
  !define MUI_FINISHPAGE_TEXT "$(MaiFinishText)"
  !define MUI_PAGE_CUSTOMFUNCTION_SHOW MaiFinishShow
  !insertmacro MUI_PAGE_FINISH
!macroend
!endif
