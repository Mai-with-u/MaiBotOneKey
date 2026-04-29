!macro customPageAfterChangeDir
  !define MUI_PAGE_CUSTOMFUNCTION_SHOW maibotShowInstallDetails
!macroend

!macro customHeader
  ShowInstDetails show
  !ifdef BUILD_UNINSTALLER
    ShowUninstDetails show
  !endif
!macroend

!macro customInstall
  SetDetailsView show
!macroend

Function maibotShowInstallDetails
  SetDetailsView show
FunctionEnd
