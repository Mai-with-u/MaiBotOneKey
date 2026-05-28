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
