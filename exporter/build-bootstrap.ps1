param(
  [Parameter(Mandatory=$true)][string]$Jdk,
  [Parameter(Mandatory=$true)][string]$Client,
  [Parameter(Mandatory=$true)][string]$OutputDirectory
)
$ErrorActionPreference = 'Stop'
$base = $PSScriptRoot
$classes = Join-Path $base 'build/bootstrap'
New-Item -ItemType Directory -Force $classes | Out-Null
& (Join-Path $Jdk 'bin/javac.exe') --release 8 -encoding UTF-8 -cp (Join-Path $Client 'client.jar') -d $classes (Join-Path $base 'bootstrap/AtlasBootstrap.java')
if ($LASTEXITCODE -ne 0) { throw 'Bootstrap compilation failed' }
$worker = (Join-Path $base 'build/atlas-exporter.jar').Replace('\','/')
$out = ([IO.Path]::GetFullPath($OutputDirectory)).Replace('\','/')
"worker=$worker`noutput=$out`n" | Set-Content -LiteralPath (Join-Path $classes 'atlas-local.properties') -Encoding ascii
& (Join-Path $Jdk 'bin/jar.exe') cf (Join-Path $base 'build/uniland-exporter-bootstrap.jar') -C $classes .
if ($LASTEXITCODE -ne 0) { throw 'Bootstrap packaging failed' }
