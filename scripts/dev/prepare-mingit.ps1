$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$taskRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../..'))
$taskTarget = [IO.Path]::GetFullPath((Join-Path $taskRoot 'runtime/git'))
if ($taskTarget -ne (Join-Path $taskRoot 'runtime\git')) { throw 'Invalid Git runtime destination' }
$taskTemp = Join-Path ([IO.Path]::GetTempPath()) ('onekey-mingit-' + [guid]::NewGuid())
New-Item -ItemType Directory -Path $taskTemp | Out-Null
try {
    $taskZip = Join-Path $taskTemp 'mingit.zip'
    Invoke-WebRequest -UseBasicParsing -Uri 'https://github.com/git-for-windows/git/releases/download/v2.56.0.windows.2/MinGit-2.56.0.2-64-bit.zip' -OutFile $taskZip
    $taskHasher = [Security.Cryptography.SHA256]::Create()
    $taskHash = [BitConverter]::ToString($taskHasher.ComputeHash([IO.File]::ReadAllBytes($taskZip))).Replace('-', '')
    $taskHasher.Dispose()
    if ($taskHash -ne 'DA35E72AA21C005A5A0D298CFBAE110BC1609A815730EA0DDE84B01A1B3CD3BE') {
        throw 'MinGit SHA-256 mismatch'
    }
    $taskExtracted = Join-Path $taskTemp 'git'
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    [IO.Compression.ZipFile]::ExtractToDirectory($taskZip, $taskExtracted)
    & (Join-Path $taskExtracted 'cmd/git.exe') --version
    if ($LASTEXITCODE -ne 0) { throw 'MinGit cannot run' }
    if (Test-Path -LiteralPath $taskTarget) { Remove-Item -LiteralPath $taskTarget -Recurse -Force }
    New-Item -ItemType Directory -Force -Path (Split-Path $taskTarget) | Out-Null
    Move-Item -LiteralPath $taskExtracted -Destination $taskTarget
    Write-Host "[runtime] MinGit installed: $taskTarget"
} finally {
    if ([IO.Path]::GetFullPath($taskTemp).StartsWith([IO.Path]::GetFullPath([IO.Path]::GetTempPath()) + 'onekey-mingit-')) {
        Remove-Item -LiteralPath $taskTemp -Recurse -Force
    }
}
