!ifndef BUILD_UNINSTALLER
!macro customPageAfterChangeDir
  ShowInstDetails hide
!macroend
!endif

!macro customHeader
  ShowInstDetails hide
  !ifdef BUILD_UNINSTALLER
    ShowUninstDetails hide
  !endif
!macroend
