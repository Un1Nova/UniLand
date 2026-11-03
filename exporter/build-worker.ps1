param([Parameter(Mandatory=$true)][string]$Jdk)
$ErrorActionPreference = 'Stop'
$classes = Join-Path $PSScriptRoot 'build/worker-classes'
New-Item -ItemType Directory -Force $classes | Out-Null
$sources = @(Get-ChildItem -LiteralPath (Join-Path $PSScriptRoot 'src/atlas') -Filter '*.java' | ForEach-Object FullName)
& (Join-Path $Jdk 'bin/javac.exe') --release 17 -encoding UTF-8 -d $classes @sources
if ($LASTEXITCODE -ne 0) { throw 'Worker compilation failed' }
$workerName = 'atlas-worker-' + [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() + '.jar'
& (Join-Path $Jdk 'bin/jar.exe') cf (Join-Path $PSScriptRoot ('build/' + $workerName)) -C $classes atlas
if ($LASTEXITCODE -ne 0) { throw 'Worker packaging failed' }
Write-Output $workerName
