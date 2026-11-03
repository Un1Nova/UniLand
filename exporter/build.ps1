param([Parameter(Mandatory=$true)][string]$Jdk, [switch]$WorkerOnly)
$ErrorActionPreference = 'Stop'
$base = $PSScriptRoot
$classes = Join-Path $base 'build/classes'
New-Item -ItemType Directory -Force $classes | Out-Null
$sources = @(Get-ChildItem -LiteralPath (Join-Path $base 'src') -Recurse -Filter '*.java' | ForEach-Object FullName)
& (Join-Path $Jdk 'bin/javac.exe') --release 17 -encoding UTF-8 -d $classes @sources
if ($LASTEXITCODE -ne 0) { throw 'Compilation failed' }
$manifest = Join-Path $base 'build/MANIFEST.MF'
"Manifest-Version: 1.0`nAgent-Class: AtlasAgent`nPremain-Class: AtlasAgent`nCan-Redefine-Classes: false`nCan-Retransform-Classes: false`n`n" | Set-Content -LiteralPath $manifest -Encoding ascii
if (-not $WorkerOnly) {
  & (Join-Path $Jdk 'bin/jar.exe') cfm (Join-Path $base 'build/atlas-exporter.jar') $manifest -C $classes .
  if ($LASTEXITCODE -ne 0) { throw 'Packaging failed' }
}
& (Join-Path $Jdk 'bin/jar.exe') cf (Join-Path $base 'build/atlas-worker.jar') -C $classes atlas
if ($LASTEXITCODE -ne 0) { throw 'Worker packaging failed' }
