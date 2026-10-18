# Build the presentation helper independently of the application payload.
[CmdletBinding()]
param([switch]$TestPresentation)
$ErrorActionPreference = 'Stop'
$projectRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../..'))
$outputDirectory = Join-Path $projectRoot '.codex-tmp/installer-ui'
New-Item -ItemType Directory -Force -Path $outputDirectory | Out-Null
$vswhere = Join-Path ${env:ProgramFiles(x86)} 'Microsoft Visual Studio/Installer/vswhere.exe'
if (-not (Test-Path -LiteralPath $vswhere)) { throw 'Installer UI requires Visual Studio C++ Build Tools and a Windows SDK.' }
$visualStudio = & $vswhere -latest -products '*' -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath
if (-not $visualStudio) { throw 'Installer UI requires the Visual Studio x86 C++ build tools.' }
$vcvars = Join-Path $visualStudio 'VC/Auxiliary/Build/vcvars32.bat'
$source = Join-Path $projectRoot 'resources/installer/millennium.cpp'
$library = Join-Path $outputDirectory 'millennium.dll'
$compileScript = Join-Path $outputDirectory 'compile.cmd'
$compileLines = @(
    '@echo off'
    ('call "{0}" >nul' -f $vcvars)
    'if errorlevel 1 exit /b %errorlevel%'
    ('cl /nologo /std:c++17 /utf-8 /LD /MT /O1 /W4 /WX /EHsc "{0}" /Fo"{1}" /link /OUT:"{2}" /IMPLIB:"{3}" user32.lib gdi32.lib comctl32.lib dwmapi.lib' -f $source, (Join-Path $outputDirectory 'millennium.obj'), $library, (Join-Path $outputDirectory 'millennium.lib'))
)
[IO.File]::WriteAllLines($compileScript, $compileLines, [Text.Encoding]::Default)
& $env:ComSpec /d /c $compileScript
if ($LASTEXITCODE -ne 0) { throw 'Installer UI compilation failed.' }
if ($TestPresentation) {
    $testSource = Join-Path $projectRoot 'scripts/tests/installer-presentation.cpp'
    $testExecutable = Join-Path $outputDirectory 'presentation-test.exe'
    $testCompileScript = Join-Path $outputDirectory 'compile-test.cmd'
    $testCompileLines = @(
        '@echo off'
        ('call "{0}" >nul' -f $vcvars)
        'if errorlevel 1 exit /b %errorlevel%'
        ('cl /nologo /std:c++17 /utf-8 /MT /O1 /W4 /WX /EHsc "{0}" /Fo"{1}" /Fe"{2}" /link user32.lib gdi32.lib comctl32.lib dwmapi.lib' -f $testSource, (Join-Path $outputDirectory 'presentation-test.obj'), $testExecutable)
    )
    [IO.File]::WriteAllLines($testCompileScript, $testCompileLines, [Text.Encoding]::Default)
    & $env:ComSpec /d /c $testCompileScript
    if ($LASTEXITCODE -ne 0) { throw 'Installer presentation test compilation failed.' }
    & $testExecutable
    if ($LASTEXITCODE -ne 0) { throw 'Installer presentation regression failed.' }
}
Write-Output "Prepared Millennium installer UI: $library"
