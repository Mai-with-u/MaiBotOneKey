!include nsDialogs.nsh
Var MaiInstanceRoot
Var MaiInstanceDialog
Var MaiInstanceEdit
Var MaiInstanceBrowse
Var MaiInstanceNote

Function MaiInstancePage
  ${if} ${isUpdated}
    Abort
  ${endif}
  !insertmacro MUI_HEADER_TEXT "首个实例的存放位置" "可留空使用默认位置；已有实例的路径保持不变。"
  nsDialogs::Create 1018
  Pop $MaiInstanceDialog
  ${If} $MaiInstanceDialog == error
    Abort
  ${EndIf}
  ${NSD_CreateDirRequest} 0 10u 75% 14u "$MaiInstanceRoot"
  Pop $MaiInstanceEdit
  System::Call 'user32::SetWindowLongW(p $MaiInstanceEdit, i -12, i 1100)'
  ${NSD_CreateBrowseButton} 78% 10u 22% 14u "浏览…"
  Pop $MaiInstanceBrowse
  System::Call 'user32::SetWindowLongW(p $MaiInstanceBrowse, i -12, i 1101)'
  ${NSD_OnClick} $MaiInstanceBrowse MaiInstanceBrowseClick
  ${NSD_CreateLabel} 0 40u 100% 65u "新用户可以选择任意可写的空文件夹。组件将在其中的 modules 下初始化。$\r$\n$\r$\n安装后可在实例管理中添加实例、分别选择组件目录或迁移已有组件。此选项不会搬动或覆盖旧实例。"
  Pop $MaiInstanceNote
  System::Call 'user32::SetWindowLongW(p $MaiInstanceNote, i -12, i 1102)'
  System::Call '$PLUGINSDIR\millennium.dll::StylePage(p $HWNDPARENT, p $MaiInstanceDialog, i 5) ?c'
  nsDialogs::Show
FunctionEnd

Function MaiInstanceBrowseClick
  Pop $0
  nsDialogs::SelectFolderDialog "选择首个实例的空文件夹" "$MaiInstanceRoot"
  Pop $0
  ${If} $0 != error
    ${NSD_SetText} $MaiInstanceEdit $0
  ${EndIf}
FunctionEnd

!macro MaiNormalizeDirectory input register
  ClearErrors
  GetFullPathName $${register} "${input}"
  ${If} ${Errors}
    ; NSIS GetFullPathName needs an existing entry. Resolve new folders lexically.
    StrCpy $3 "${input}"
    System::Call 'kernel32::GetFullPathNameW(w r3, i ${NSIS_MAX_STRLEN}, w .r${register}, p 0) i.r0'
    ${If} $0 == 0
    ${OrIf} $0 >= ${NSIS_MAX_STRLEN}
      MessageBox MB_OK|MB_ICONEXCLAMATION "无法解析所选目录，请选择其他位置。"
      Abort
    ${EndIf}
  ${EndIf}
!macroend

Function MaiInstanceLeave
  ${NSD_GetText} $MaiInstanceEdit $MaiInstanceRoot
  ${If} $MaiInstanceRoot == ""
    Return
  ${EndIf}
  StrCpy $1 $MaiInstanceRoot
  System::Call 'shlwapi::PathIsRelativeW(w r1) i.r0'
  ${If} $0 != 0
    MessageBox MB_OK|MB_ICONEXCLAMATION "请选择完整的绝对目录路径。"
    Abort
  ${EndIf}
  System::Call 'shlwapi::PathIsRootW(w r1) i.r0'
  ${If} $0 != 0
    MessageBox MB_OK|MB_ICONEXCLAMATION "请使用独立文件夹，不要直接使用磁盘根目录。"
    Abort
  ${EndIf}
  !insertmacro MaiNormalizeDirectory $MaiInstanceRoot 1
  !insertmacro MaiNormalizeDirectory $INSTDIR 2
  StrCpy $3 $1 1 -1
  ${If} $3 != "\"
    StrCpy $1 "$1\"
  ${EndIf}
  StrCpy $3 $2 1 -1
  ${If} $3 != "\"
    StrCpy $2 "$2\"
  ${EndIf}
  StrLen $3 $1
  StrCpy $4 $2 $3
  ${If} $1 == $4
    MessageBox MB_OK|MB_ICONEXCLAMATION "实例目录不能包含程序安装目录。"
    Abort
  ${EndIf}
  StrLen $3 $2
  StrCpy $4 $1 $3
  ${If} $2 == $4
    MessageBox MB_OK|MB_ICONEXCLAMATION "实例目录不能放在程序安装目录内。"
    Abort
  ${EndIf}
  ClearErrors
  CreateDirectory "$MaiInstanceRoot"
  GetTempFileName $0 "$MaiInstanceRoot"
  ${If} ${Errors}
    MessageBox MB_OK|MB_ICONEXCLAMATION "无法写入所选目录，请选择其他位置。"
    Abort
  ${EndIf}
  Delete "$0"
  FindFirst $0 $1 "$MaiInstanceRoot\*.*"
  ${DoWhile} $1 != ""
    ${If} $1 != "."
    ${AndIf} $1 != ".."
      FindClose $0
      MessageBox MB_OK|MB_ICONEXCLAMATION "请选择空文件夹。已有实例请在启动器中接入；升级时可留空以保留原路径。"
      Abort
    ${EndIf}
    FindNext $0 $1
  ${Loop}
  FindClose $0
FunctionEnd

!macro customInstall
  ; UTF-16LE handoff belongs to the installation, not the elevated installer's AppData.
  ; The app consumes it only when no existing instance configuration is available.
  ${If} $MaiInstanceRoot != ""
    FileOpen $0 "$INSTDIR\instance-location.ini" w
    FileWriteUTF16LE $0 "[instance]$\r$\nroot=$MaiInstanceRoot$\r$\n"
    FileClose $0
  ${EndIf}
!macroend
