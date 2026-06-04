$ErrorActionPreference = 'Stop'
$env:PATH = "C:\Program Files\dotnet;$env:PATH"
$projectDir = Join-Path $PSScriptRoot 'BrandonCaptions'
$outDir = Join-Path $PSScriptRoot '..\client\resources\bin'
New-Item -ItemType Directory -Force -Path $outDir | Out-Null

Push-Location $projectDir
try {
  dotnet publish -c Release -r win-x64 --self-contained `
    -p:PublishSingleFile=true `
    -p:IncludeNativeLibrariesForSelfExtract=true `
    -o $outDir --nologo
} finally {
  Pop-Location
}

Write-Host ""
Write-Host "Sidecar published to:" -ForegroundColor Green
Get-ChildItem $outDir | Format-Table Name, Length -AutoSize
