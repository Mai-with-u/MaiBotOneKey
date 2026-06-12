import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

async function patchFile(
  path: string,
  patchName: string,
  pattern: RegExp,
  replacement: string,
  alreadyPatched: string | string[],
  options: { optional?: boolean } = {},
): Promise<void> {
  const content = await readFile(path, "utf8");
  const alreadyPatchedMarkers = Array.isArray(alreadyPatched) ? alreadyPatched : [alreadyPatched];
  if (alreadyPatchedMarkers.some((marker) => content.includes(marker))) {
    console.log(`[ok] ${patchName}: already patched`);
    return;
  }

  if (!pattern.test(content)) {
    if (options.optional) {
      console.log(`[ok] ${patchName}: not needed`);
      return;
    }
    throw new Error(`${patchName}: expected template content was not found in ${path}`);
  }

  await writeFile(path, content.replace(pattern, replacement), "utf8");
  console.log(`[ok] ${patchName}: patched`);
}

const nsisTemplateRoot = join(process.cwd(), "node_modules", "app-builder-lib", "templates", "nsis");

await patchFile(
  join(nsisTemplateRoot, "installSection.nsh"),
  "enable NSIS details output",
  /(\$\{IfNot\} \$\{Silent\}\r?\n)\s*SetDetailsPrint none(\r?\n\$\{endif\})/u,
  "$1  SetDetailsPrint both$2",
  "SetDetailsPrint both",
);

await patchFile(
  join(nsisTemplateRoot, "include", "extractAppPackage.nsh"),
  "show copied files in NSIS details",
  /CopyFiles \/SILENT "\$PLUGINSDIR\\7z-out\\\*" \$OUTDIR/u,
  'CopyFiles "$PLUGINSDIR\\7z-out\\*" $OUTDIR',
  [
    'CopyFiles "$PLUGINSDIR\\7z-out\\*" $OUTDIR',
    'CopyFiles "$R2\\*" $OUTDIR',
    'Rename "$R2" "$OUTDIR"',
    'Rename "$R2" "$R0"',
  ],
);

await patchFile(
  join(nsisTemplateRoot, "include", "installer.nsh"),
  "write uninstaller to final install dir",
  /\r?\n  File "\/oname=\$\{UNINSTALL_FILENAME\}" "\$\{UNINSTALLER_OUT_FILE\}"/u,
  `\n  SetOutPath $INSTDIR\n  File "/oname=\${UNINSTALL_FILENAME}" "\${UNINSTALLER_OUT_FILE}"`,
  'SetOutPath $INSTDIR\n  File "/oname=${UNINSTALL_FILENAME}" "${UNINSTALLER_OUT_FILE}"',
);

await patchFile(
  join(nsisTemplateRoot, "include", "extractAppPackage.nsh"),
  "stage app extraction beside install dir before rename",
  /Push \$OUTDIR\r?\n  CreateDirectory "\$PLUGINSDIR\\7z-out"\r?\n  ClearErrors\r?\n  SetOutPath "\$PLUGINSDIR\\7z-out"([\s\S]*?)CopyFiles (?:\/SILENT )?"\$PLUGINSDIR\\7z-out\\\*" \$OUTDIR([\s\S]*?)RMDir \/r "\$PLUGINSDIR\\7z-out"([\s\S]*?)DoneExtract7za:\r?\n!macroend/u,
  `Push $OUTDIR
  StrCpy $R2 "$OUTDIR.__installing-$packageArch"
  StrCpy $R3 "$OUTDIR.__old-$packageArch"
  RMDir /r "$R2"
  RMDir /r "$R3"
  CreateDirectory "$R2"
  ClearErrors
  SetOutPath "$R2"$1SetOutPath "$PLUGINSDIR"
    ClearErrors
    Rename "$R0" "$R3"
    IfErrors 0 RenameStaged7za
    ClearErrors
    RMDir "$R0"
    IfErrors 0 RenameStaged7za
    IfFileExists "$R0\\*.*" HandleExtract7zaError RenameStaged7za

  RenameStaged7za:
    ClearErrors
    Rename "$R2" "$R0"
    IfErrors HandleExtract7zaError DoneExtract7za

  HandleExtract7zaError:$2IfFileExists "$R0\\*.*" 0 RestoreOld7za
    Goto ReportExtract7zaError

  RestoreOld7za:
    IfFileExists "$R3\\*.*" 0 ReportExtract7zaError
    Rename "$R3" "$R0"

  ReportExtract7zaError:
    CreateDirectory "$R0"
    SetOutPath "$R0"
    RMDir /r "$R2"
    RMDir /r "$R3"$3DoneExtract7za:
    RMDir /r "$R2"
    RMDir /r "$R3"
!macroend`,
  'StrCpy $R2 "$OUTDIR.__installing-$packageArch"',
  { optional: true },
);

await patchFile(
  join(nsisTemplateRoot, "include", "extractAppPackage.nsh"),
  "migrate temp staged extraction to install-dir rename",
  /Push \$OUTDIR\r?\n  StrCpy \$R2 "\$TEMP\\MaiBotOneKeyInstall-\$packageArch"\r?\n  RMDir \/r "\$R2"\r?\n  CreateDirectory "\$R2"\r?\n  ClearErrors\r?\n  SetOutPath "\$R2"([\s\S]*?)CopyFiles "\$R2\\\*" \$OUTDIR([\s\S]*?)RMDir \/r "\$R2"([\s\S]*?)DoneExtract7za:\r?\n    RMDir \/r "\$R2"\r?\n!macroend/u,
  `Push $OUTDIR
  StrCpy $R2 "$OUTDIR.__installing-$packageArch"
  StrCpy $R3 "$OUTDIR.__old-$packageArch"
  RMDir /r "$R2"
  RMDir /r "$R3"
  CreateDirectory "$R2"
  ClearErrors
  SetOutPath "$R2"$1SetOutPath "$PLUGINSDIR"
    ClearErrors
    Rename "$R0" "$R3"
    IfErrors 0 RenameStaged7za
    ClearErrors
    RMDir "$R0"
    IfErrors 0 RenameStaged7za
    IfFileExists "$R0\\*.*" HandleExtract7zaError RenameStaged7za

  RenameStaged7za:
    ClearErrors
    Rename "$R2" "$R0"
    IfErrors HandleExtract7zaError DoneExtract7za

  HandleExtract7zaError:$2IfFileExists "$R0\\*.*" 0 RestoreOld7za
    Goto ReportExtract7zaError

  RestoreOld7za:
    IfFileExists "$R3\\*.*" 0 ReportExtract7zaError
    Rename "$R3" "$R0"

  ReportExtract7zaError:
    CreateDirectory "$R0"
    SetOutPath "$R0"
    RMDir /r "$R2"
    RMDir /r "$R3"$3DoneExtract7za:
    RMDir /r "$R2"
    RMDir /r "$R3"
!macroend`,
  'StrCpy $R2 "$OUTDIR.__installing-$packageArch"',
  { optional: true },
);

await patchFile(
  join(nsisTemplateRoot, "include", "extractAppPackage.nsh"),
  "ensure direct-extract fallback targets install dir",
  /HandleExtract7zaError:\r?\n    IfErrors 0 DoneExtract7za([\s\S]*?)RMDir \/r "\$R2"\r?\n    RMDir \/r "\$R3"\r?\n\r?\n    Nsis7z::Extract "\$\{FILE\}"/u,
  `HandleExtract7zaError:
    IfErrors 0 DoneExtract7za$1CreateDirectory "$R0"
    SetOutPath "$R0"
    RMDir /r "$R2"
    RMDir /r "$R3"

    Nsis7z::Extract "\${FILE}"`,
  'CreateDirectory "$R0"\n    SetOutPath "$R0"\n    RMDir /r "$R2"',
  { optional: true },
);

await patchFile(
  join(nsisTemplateRoot, "include", "extractAppPackage.nsh"),
  "restore old install dir before retrying staged rename",
  /HandleExtract7zaError:\r?\n    IfErrors 0 DoneExtract7za\r?\n\r?\n    DetailPrint/u,
  `HandleExtract7zaError:
    IfErrors 0 DoneExtract7za

    IfFileExists "$R0\\*.*" 0 RestoreOld7za
    Goto ReportExtract7zaError

  RestoreOld7za:
    IfFileExists "$R3\\*.*" 0 ReportExtract7zaError
    Rename "$R3" "$R0"

  ReportExtract7zaError:
    DetailPrint`,
  'RestoreOld7za:',
  { optional: true },
);

await patchFile(
  join(nsisTemplateRoot, "include", "extractAppPackage.nsh"),
  "handle pre-created empty install dir during staged rename",
  /IfFileExists "\$OUTDIR\\\*\.\*" 0 RenameStaged7za\r?\n    Rename "\$OUTDIR" "\$R3"\r?\n    IfErrors 0 RenameStaged7za\r?\n    Goto HandleExtract7zaError/u,
  `ClearErrors
    Rename "$OUTDIR" "$R3"
    IfErrors 0 RenameStaged7za
    ClearErrors
    RMDir "$OUTDIR"
    IfErrors 0 RenameStaged7za
    IfFileExists "$OUTDIR\\*.*" HandleExtract7zaError RenameStaged7za`,
  'RMDir "$OUTDIR"',
  { optional: true },
);

await patchFile(
  join(nsisTemplateRoot, "include", "extractAppPackage.nsh"),
  "remove unused staged-rename label",
  /\r?\n  PrepareTarget7za:/u,
  "",
  'unused staged-rename label removed',
  { optional: true },
);

await patchFile(
  join(nsisTemplateRoot, "include", "extractAppPackage.nsh"),
  "avoid locking install dir before staged rename",
  /(# Attempt to copy files in atomic way\r?\n)    ClearErrors/u,
  `$1    SetOutPath "$PLUGINSDIR"
    ClearErrors`,
  'SetOutPath "$PLUGINSDIR"',
  { optional: true },
);

await patchFile(
  join(nsisTemplateRoot, "include", "extractAppPackage.nsh"),
  "clear stale errors before final staged rename",
  /(\r?\n  RenameStaged7za:\r?\n)    Rename "\$R2" "\$OUTDIR"/u,
  `$1    ClearErrors
    Rename "$R2" "$OUTDIR"`,
  'RenameStaged7za:\n    ClearErrors',
  { optional: true },
);

await patchFile(
  join(nsisTemplateRoot, "include", "extractAppPackage.nsh"),
  "use saved install dir after changing SetOutPath",
  /ClearErrors\r?\n    Rename "\$OUTDIR" "\$R3"\r?\n    IfErrors 0 RenameStaged7za\r?\n    ClearErrors\r?\n    RMDir "\$OUTDIR"\r?\n    IfErrors 0 RenameStaged7za\r?\n    IfFileExists "\$OUTDIR\\\*\.\*" HandleExtract7zaError RenameStaged7za([\s\S]*?)Rename "\$R2" "\$OUTDIR"([\s\S]*?)IfFileExists "\$OUTDIR\\\*\.\*" 0 RestoreOld7za([\s\S]*?)Rename "\$R3" "\$OUTDIR"([\s\S]*?)CreateDirectory "\$OUTDIR"\r?\n    SetOutPath "\$OUTDIR"/u,
  `ClearErrors
    Rename "$R0" "$R3"
    IfErrors 0 RenameStaged7za
    ClearErrors
    RMDir "$R0"
    IfErrors 0 RenameStaged7za
    IfFileExists "$R0\\*.*" HandleExtract7zaError RenameStaged7za$1Rename "$R2" "$R0"$2IfFileExists "$R0\\*.*" 0 RestoreOld7za$3Rename "$R3" "$R0"$4CreateDirectory "$R0"
    SetOutPath "$R0"`,
  'Rename "$R2" "$R0"',
  { optional: true },
);

await patchFile(
  join(nsisTemplateRoot, "include", "extractAppPackage.nsh"),
  "dedupe direct-extract fallback SetOutPath",
  /CreateDirectory "\$R0"\r?\n    SetOutPath "\$R0"\r?\n    CreateDirectory "\$R0"\r?\n    SetOutPath "\$R0"/u,
  `CreateDirectory "$R0"
    SetOutPath "$R0"`,
  'CreateDirectory "$R0"\n    SetOutPath "$R0"\n    RMDir /r "$R2"',
  { optional: true },
);

await patchFile(
  join(nsisTemplateRoot, "include", "extractAppPackage.nsh"),
  "remove install-dir config preservation from staged install",
  /RenameStaged7za:\r?\n    ClearErrors\r?\n    Rename "\$R2" "\$R0"\r?\n    IfErrors HandleExtract7zaError PreserveUserConfigs7za\r?\n\r?\n  PreserveUserConfigs7za:\r?\n(?:    IfFileExists "\$R3\\resources\\modules\\napcat\\config\\\*\.\*" 0 \+3\r?\n      CreateDirectory "\$R0\\resources\\modules\\napcat\\config"\r?\n      CopyFiles \/SILENT "\$R3\\resources\\modules\\napcat\\config\\\*" "\$R0\\resources\\modules\\napcat\\config"\r?\n)?(?:    IfFileExists "\$R3\\resources\\modules\\napcat\\napcat\\config\\\*\.\*" 0 \+3\r?\n      CreateDirectory "\$R0\\resources\\modules\\napcat\\napcat\\config"\r?\n      CopyFiles \/SILENT "\$R3\\resources\\modules\\napcat\\napcat\\config\\\*" "\$R0\\resources\\modules\\napcat\\napcat\\config"\r?\n)?(?:    IfFileExists "\$R3\\resources\\modules\\SnowLuma\\config\\\*\.\*" 0 \+3\r?\n      CreateDirectory "\$R0\\resources\\modules\\SnowLuma\\config"\r?\n      CopyFiles \/SILENT "\$R3\\resources\\modules\\SnowLuma\\config\\\*" "\$R0\\resources\\modules\\SnowLuma\\config"\r?\n)?(?:    IfFileExists "\$R3\\resources\\modules\\SnowLuma\\data\\\*\.\*" 0 \+3\r?\n      CreateDirectory "\$R0\\resources\\modules\\SnowLuma\\data"\r?\n      CopyFiles \/SILENT "\$R3\\resources\\modules\\SnowLuma\\data\\\*" "\$R0\\resources\\modules\\SnowLuma\\data"\r?\n)?(?:    IfFileExists "\$R3\\resources\\modules\\SnowLuma\\logs\\\*\.\*" 0 \+3\r?\n      CreateDirectory "\$R0\\resources\\modules\\SnowLuma\\logs"\r?\n      CopyFiles \/SILENT "\$R3\\resources\\modules\\SnowLuma\\logs\\\*" "\$R0\\resources\\modules\\SnowLuma\\logs"\r?\n)?    Goto DoneExtract7za/u,
  `RenameStaged7za:
    ClearErrors
    Rename "$R2" "$R0"
    IfErrors HandleExtract7zaError DoneExtract7za`,
  "IfErrors HandleExtract7zaError DoneExtract7za",
  { optional: true },
);

await patchFile(
  join(nsisTemplateRoot, "include", "extractAppPackage.nsh"),
  "record staged extraction failures",
  /RMDir \/r "\$R2"\r?\n  RMDir \/r "\$R3"\r?\n  CreateDirectory "\$R2"\r?\n  ClearErrors\r?\n  SetOutPath "\$R2"\r?\n  Nsis7z::Extract "\$\{FILE\}"\r?\n  Pop \$R0\r?\n  SetOutPath \$R0/u,
  `RMDir /r "$R2"
  RMDir /r "$R3"
  ClearErrors
  CreateDirectory "$R2"
  IfErrors 0 PrepareExtract7za
    StrCpy $R4 "Cannot create staging directory: $R2"
    Goto AbortLoggedExtract7za

  PrepareExtract7za:
  ClearErrors
  SetOutPath "$R2"
  IfErrors 0 RunExtract7za
    StrCpy $R4 "Cannot enter staging directory: $R2"
    Goto AbortLoggedExtract7za

  RunExtract7za:
  ClearErrors
  Nsis7z::Extract "\${FILE}"
  IfErrors 0 Extract7zaSucceeded
    Pop $R0
    StrCpy $R4 "Nsis7z failed while extracting \${FILE} to $R2. The installer package may be damaged, disk space may be insufficient, or security software may have blocked files."
    Goto AbortLoggedExtract7za

  Extract7zaSucceeded:
  Pop $R0
  SetOutPath $R0
  IfFileExists "$R2\\\${APP_EXECUTABLE_FILENAME}" 0 MissingStagedExe7za
  IfFileExists "$R2\\resources\\*.*" 0 MissingStagedResources7za
  Goto StagedExtractReady7za

  MissingStagedExe7za:
    StrCpy $R4 "Extracted package is missing \${APP_EXECUTABLE_FILENAME} in staging directory: $R2"
    Goto AbortLoggedExtract7za

  MissingStagedResources7za:
    StrCpy $R4 "Extracted package is missing resources directory in staging directory: $R2"
    Goto AbortLoggedExtract7za

  StagedExtractReady7za:`,
  "AbortLoggedExtract7za",
);

await patchFile(
  join(nsisTemplateRoot, "include", "extractAppPackage.nsh"),
  "keep install dir available for early failure logs",
  /Push \$OUTDIR\r?\n  StrCpy \$R2 "\$OUTDIR\.__installing-\$packageArch"/u,
  `Push $OUTDIR
  StrCpy $R0 "$OUTDIR"
  StrCpy $R2 "$OUTDIR.__installing-$packageArch"`,
  'StrCpy $R0 "$OUTDIR"',
);

await patchFile(
  join(nsisTemplateRoot, "include", "extractAppPackage.nsh"),
  "record install directory replacement failures",
  /ReportExtract7za(?:Error)?:\r?\n    DetailPrint [^\r\n]+/u,
  `ReportExtract7zaError:
    StrCpy $R4 "Cannot replace install directory after $R1 attempt(s): $R0. Close running app processes, check directory permissions, or choose another install directory."
    DetailPrint \`Can't modify "\${PRODUCT_NAME}"'s files.\``,
  "Cannot replace install directory after $R1 attempt(s)",
  { optional: true },
);

await patchFile(
  join(nsisTemplateRoot, "include", "extractAppPackage.nsh"),
  "preserve old install backup until direct fallback succeeds",
  /    RMDir \/r "\$R2"\r?\n    RMDir \/r "\$R3"\r?\n\r?\n    ClearErrors\r?\n    Nsis7z::Extract "\$\{FILE\}"/u,
  `    RMDir /r "$R2"
    # Keep $R3 until final validation succeeds so a failed fallback does not destroy the old install.

    ClearErrors
    Nsis7z::Extract "\${FILE}"`,
  "Keep $R3 until final validation succeeds",
  { optional: true },
);

await patchFile(
  join(nsisTemplateRoot, "include", "extractAppPackage.nsh"),
  "verify direct extraction fallback",
  /    Nsis7z::Extract "\$\{FILE\}"\r?\n    Goto DoneExtract7za\r?\n\r?\n  AbortExtract7za:\r?\n    Quit\r?\n\r?\n  RetryExtract7za:/u,
  `    ClearErrors
    Nsis7z::Extract "\${FILE}"
    IfErrors 0 VerifyDirectExtract7za
      StrCpy $R4 "Direct extraction fallback failed while extracting \${FILE} to $R0. The installer package may be damaged, disk space may be insufficient, or security software may have blocked files."
      Goto AbortLoggedExtract7za

  VerifyDirectExtract7za:
    IfFileExists "$R0\\\${APP_EXECUTABLE_FILENAME}" 0 MissingDirectExe7za
    IfFileExists "$R0\\resources\\*.*" 0 MissingDirectResources7za
    Goto DoneExtract7za

  MissingDirectExe7za:
    StrCpy $R4 "Direct extraction fallback finished but \${APP_EXECUTABLE_FILENAME} is missing: $R0\\\${APP_EXECUTABLE_FILENAME}"
    Goto AbortLoggedExtract7za

  MissingDirectResources7za:
    StrCpy $R4 "Direct extraction fallback finished but resources directory is missing: $R0\\resources"
    Goto AbortLoggedExtract7za

  AbortExtract7za:
    StrCpy $R4 "User canceled after the installer could not replace install directory: $R0"
    Goto AbortLoggedExtract7za

  RetryExtract7za:`,
  "VerifyDirectExtract7za",
  { optional: true },
);

await patchFile(
  join(nsisTemplateRoot, "include", "extractAppPackage.nsh"),
  "validate final install payload and write failure log",
  /  DoneExtract7za:\r?\n    RMDir \/r "\$R2"\r?\n    RMDir \/r "\$R3"\r?\n!macroend/u,
  `  DoneExtract7za:
    IfFileExists "$R0\\\${APP_EXECUTABLE_FILENAME}" 0 MissingFinalExe7za
    IfFileExists "$R0\\resources\\*.*" 0 MissingFinalResources7za
    Goto FinishExtract7za

  MissingFinalExe7za:
    StrCpy $R4 "Installed package is missing \${APP_EXECUTABLE_FILENAME}: $R0\\\${APP_EXECUTABLE_FILENAME}"
    Goto AbortLoggedExtract7za

  MissingFinalResources7za:
    StrCpy $R4 "Installed package is missing resources directory: $R0\\resources"
    Goto AbortLoggedExtract7za

  AbortLoggedExtract7za:
    DetailPrint "Installation failed: $R4"
    CreateDirectory "$R0"
    SetOutPath "$R0"
    FileOpen $9 "$R0\\install-failure.log" w
    IfErrors 0 WriteInstallFailureLog7za
      DetailPrint "Failed to write install failure log: $R0\\install-failure.log"
      Goto ShowLoggedAbort7za

  WriteInstallFailureLog7za:
    FileWrite $9 "MaiBot OneKey installation failed.$\\r$\\n"
    FileWrite $9 "Reason: $R4$\\r$\\n"
    FileWrite $9 "Install directory: $R0$\\r$\\n"
    FileWrite $9 "Staging directory: $R2$\\r$\\n"
    FileWrite $9 "Old directory backup: $R3$\\r$\\n"
    FileWrite $9 "Package: \${FILE}$\\r$\\n"
    FileWrite $9 "Architecture: $packageArch$\\r$\\n"
    FileWrite $9 "Tip: If files such as \${APP_EXECUTABLE_FILENAME}, node.exe, or .node native modules are missing, check Windows Security or antivirus quarantine.$\\r$\\n"
    FileClose $9

  ShowLoggedAbort7za:
    RMDir /r "$R2"
    MessageBox MB_OK|MB_ICONSTOP "MaiBot OneKey installation failed.$\\r$\\n$\\r$\\nReason: $R4$\\r$\\n$\\r$\\nA diagnostic log was written to:$\\r$\\n$R0\\install-failure.log"
    Quit

  FinishExtract7za:
    RMDir /r "$R2"
    RMDir /r "$R3"
!macroend`,
  "install-failure.log",
);
