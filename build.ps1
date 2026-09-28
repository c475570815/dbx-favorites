# Builds the native sidecar with the .NET Framework compiler that ships with Windows, then packs a
# .dbxp (zip + checksums.json, matching crates/dbx-plugin-runtime/src/plugins/installer.rs).
#
#   powershell -File build.ps1              # compile + selftest + package
#   powershell -File build.ps1 -SkipBuild   # package only
param(
    [switch]$SkipBuild,
    [string]$OutDir = "dist"
)

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $root

$utf8 = New-Object System.Text.UTF8Encoding($false)
$manifest = [pscustomobject]([System.IO.File]::ReadAllText((Join-Path $root "manifest.json"), $utf8) | ConvertFrom-Json)
$version = $manifest.version
$target = "windows-x64"

$csc = Join-Path $env:WINDIR "Microsoft.NET\Framework64\v4.0.30319\csc.exe"
if (-not (Test-Path $csc)) { throw "csc.exe not found at $csc" }

if (-not $SkipBuild) {
    Write-Host "Building: C# sidecar ($target)"
    New-Item -ItemType Directory -Force -Path (Join-Path $root "bin") | Out-Null
    $sources = @("Json.cs", "Bridge.cs", "Store.cs", "Program.cs") | ForEach-Object { Join-Path $root ("backend\" + $_) }
    $exe = Join-Path $root "bin\dbx-favorites.exe"
    & $csc -nologo -utf8output -optimize+ -target:exe ("-out:" + $exe) $sources
    if ($LASTEXITCODE -ne 0) { throw "csc failed with $LASTEXITCODE" }

    Write-Host "Testing: sidecar selftest"
    & $exe --selftest
    if ($LASTEXITCODE -ne 0) { throw "selftest failed with $LASTEXITCODE" }
}

$exePath = Join-Path $root "bin\dbx-favorites.exe"
if (-not (Test-Path $exePath)) { throw "missing $exePath; run without -SkipBuild" }

function Get-Relative([string]$absolute) {
    $relative = $absolute.Substring($root.Length).TrimStart("\", "/").Replace("\", "/")
    return $relative
}

Write-Host "Staging package"
$entries = New-Object System.Collections.Generic.List[object]
foreach ($item in (Get-ChildItem -Recurse -File -Path (Join-Path $root "assets"), (Join-Path $root "ui"))) {
    $entries.Add([pscustomobject]@{ Name = (Get-Relative $item.FullName); Path = $item.FullName })
}
$entries.Add([pscustomobject]@{ Name = "manifest.json"; Path = (Join-Path $root "manifest.json") })
# entrypoints.backend.executable is resolved verbatim against the plugin directory, so keep the
# flat bin/ path inside the archive instead of the per-target layout the official packager rewrites.
$entries.Add([pscustomobject]@{ Name = (Get-Relative $exePath); Path = $exePath })

$names = $entries | ForEach-Object { $_.Name.ToLowerInvariant() } | Sort-Object -Unique
if ($names.Count -ne $entries.Count) { throw "duplicate entry names detected" }

$sha256 = [System.Security.Cryptography.SHA256]::Create()
$checksums = [ordered]@{ algorithm = "sha256"; files = [ordered]@{} }
foreach ($entry in $entries) {
    $stream = [System.IO.File]::OpenRead($entry.Path)
    try {
        $hash = $sha256.ComputeHash($stream)
    } finally {
        $stream.Dispose()
    }
    $checksums.files[$entry.Name] = ([System.BitConverter]::ToString($hash) -replace "-", "").ToLowerInvariant()
}

New-Item -ItemType Directory -Force -Path (Join-Path $root $OutDir) | Out-Null
$packageName = "{0}-{1}-{2}.dbxp" -f $manifest.id, $version, $target
$packagePath = Join-Path (Join-Path $root $OutDir) $packageName

Add-Type -AssemblyName System.IO.Compression
Add-Type -AssemblyName System.IO.Compression.FileSystem
if (Test-Path $packagePath) { Remove-Item $packagePath -Force }

$archive = [System.IO.Compression.ZipFile]::Open($packagePath, [System.IO.Compression.ZipArchiveMode]::Create)
try {
    foreach ($entry in $entries) {
        $item = $archive.CreateEntry($entry.Name, [System.IO.Compression.CompressionLevel]::Optimal)
        $entryStream = $item.Open()
        try {
            $bytes = [System.IO.File]::ReadAllBytes($entry.Path)
            $entryStream.Write($bytes, 0, $bytes.Length)
        } finally {
            $entryStream.Dispose()
        }
    }
    $metaEntry = $archive.CreateEntry("checksums.json", [System.IO.Compression.CompressionLevel]::Optimal)
    $metaStream = $metaEntry.Open()
    try {
        $json = ($checksums | ConvertTo-Json -Depth 6)
        $metaBytes = $utf8.GetBytes($json)
        $metaStream.Write($metaBytes, 0, $metaBytes.Length)
    } finally {
        $metaStream.Dispose()
    }
} finally {
    $archive.Dispose()
}

$size = (Get-Item $packagePath).Length
Write-Host ("Packaged: {0} ({1:n0} bytes, {2} files)" -f $packagePath, $size, ($entries.Count + 1))
Write-Host "Install: DBX 插件中心 → 设置 → 允许安装未签名开发包 → 安装 .dbxp"
