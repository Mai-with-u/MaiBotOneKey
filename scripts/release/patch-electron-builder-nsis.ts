import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

async function patchFile(
  path: string,
  patchName: string,
  pattern: RegExp,
  replacement: string,
  alreadyPatched: string,
): Promise<void> {
  const content = await readFile(path, "utf8");
  if (content.includes(alreadyPatched)) {
    console.log(`[ok] ${patchName}: already patched`);
    return;
  }

  if (!pattern.test(content)) {
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
  'CopyFiles "$PLUGINSDIR\\7z-out\\*" $OUTDIR',
);
