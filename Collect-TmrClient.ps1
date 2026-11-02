#requires -Version 5.1
<#
.SYNOPSIS
Offline collector of selected LoliLand client inputs, not a recipe exporter.
.DESCRIPTION
Finds only known client folders, or uses -ClientPath. Never reads launcher
storage/account data. Creates an inventory first; archives require -CreateZip
or an explicit interactive YES. JARs are copied, never loaded or executed.
Each ZIP stays below -MaxPartMiB (350 MiB by default). Large files are split
into chunks; each archive contains its own reconstruction manifest.
.EXAMPLE
  .\Collect-TmrClient.ps1
.EXAMPLE
  .\Collect-TmrClient.ps1 -ClientPath 'D:\LoliLand\game-resources\clients\YOUR_CLIENT\YOUR_BRANCH' -CreateZip
#>
[CmdletBinding()]
param(
    [string]$ClientPath,
    [string]$ClientsRoot,
    [string]$OutputDirectory,
    [switch]$CreateZip,
    [switch]$NonInteractive,
    [ValidateRange(1,2048)][int]$MaxPartMiB = 350
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$script:Excluded = New-Object 'System.Collections.Generic.List[object]'
$script:Candidates = New-Object 'System.Collections.Generic.List[object]'
$script:SeenCandidates = @{}
$script:ClientRoot = $null
$script:PathComparison = [System.StringComparison]::OrdinalIgnoreCase
if ([System.IO.Path]::DirectorySeparatorChar -ne '\') {
    $script:PathComparison = [System.StringComparison]::Ordinal
}
$script:Utf8 = New-Object System.Text.UTF8Encoding($false)
$script:SensitiveNames = '(?i)(^|[/\\])(?:launcher-data|logs?|saves?|screenshots?|crash-reports|accounts?|auth|authentication|credentials?|sessions?|tokens?|secrets?)(?:[/\\._-]|$)|password|passwd|credential|access[-_]?token|refresh[-_]?token|session[-_]?id|client[-_]?secret|(?:^|[/\\])storage\.txt(?:$|\.)|(?:^|[/\\])servers\.dat(?:$|\.)'
$script:CredentialPattern = '(?i)(?<![a-z0-9_])(?:password|passwd|pwd|access[-_]?token|refresh[-_]?token|auth[-_]?token|client[-_]?secret|api[-_]?key|session(?:[-_]?id|[-_]?key|[-_]?token)?|authorization|credentials?|private[-_]?key|username|login|email|cookies?|token)["''\s]*[:=]|-----BEGIN(?: [A-Z]+)? PRIVATE KEY-----|https?://[^/\s:@]+:[^/\s@]+@'

function Test-ReparsePoint([System.IO.FileSystemInfo]$Item) {
    return (($Item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0)
}

function Assert-PlainDirectory([string]$Path) {
    $full = [System.IO.Path]::GetFullPath($Path)
    $item = Get-Item -LiteralPath $full -Force
    if (-not $item.PSIsContainer) { throw "Not a directory: $full" }
    $cursor = $item
    while ($null -ne $cursor) {
        if (Test-ReparsePoint $cursor) { throw "Symlink/junction input paths are not collected: $($cursor.FullName)" }
        $cursor = $cursor.Parent
    }
    return $item.FullName.TrimEnd([System.IO.Path]::DirectorySeparatorChar, [System.IO.Path]::AltDirectorySeparatorChar)
}

function Get-RelativeClientPath([string]$Path) {
    $full = [System.IO.Path]::GetFullPath($Path)
    $prefix = $script:ClientRoot + [System.IO.Path]::DirectorySeparatorChar
    if (-not $full.StartsWith($prefix, $script:PathComparison)) { throw 'A candidate escaped the selected client folder.' }
    $relative = $full.Substring($prefix.Length).Replace('\','/')
    if ($relative.Length -gt 2048 -or $relative -match '(^|/)\.\.(/|$)|[\x00-\x1f]') { throw 'Unsafe archive path.' }
    return $relative
}

function Add-Exclusion([string]$Path, [string]$Reason) {
    $script:Excluded.Add([ordered]@{ path = (Get-RelativeClientPath $Path); reason = $Reason })
}

function Get-SafeFiles([string]$Directory) {
    if (-not (Test-Path -LiteralPath $Directory -PathType Container)) { return }
    $first = Get-Item -LiteralPath $Directory -Force
    if (Test-ReparsePoint $first) { Add-Exclusion $Directory 'symlink-or-junction-not-followed'; return }
    try { [void](Assert-PlainDirectory $Directory) }
    catch { Add-Exclusion $Directory 'linked-parent-not-followed'; return }
    $pending = New-Object 'System.Collections.Generic.Stack[string]'
    $pending.Push($first.FullName)
    while ($pending.Count -gt 0) {
        $current = $pending.Pop()
        foreach ($entry in @(Get-ChildItem -LiteralPath $current -Force)) {
            $rel = Get-RelativeClientPath $entry.FullName
            if ($rel -match $script:SensitiveNames) { Add-Exclusion $entry.FullName 'sensitive-path-not-read'; continue }
            if (Test-ReparsePoint $entry) { Add-Exclusion $entry.FullName 'symlink-or-junction-not-followed'; continue }
            if ($entry.PSIsContainer) { $pending.Push($entry.FullName) }
            else { Write-Output $entry }
        }
    }
}

function Test-CredentialContent([string]$Path) {
    # Scan selected scripts/configs only. No credentials or matching values are
    # written to output. This also checks UTF-16 configuration text.
    $stream = [System.IO.File]::Open($Path, [System.IO.FileMode]::Open, [System.IO.FileAccess]::Read, [System.IO.FileShare]::Read)
    try {
        $buffer = New-Object byte[] 65536
        $tail8 = ''; $tail16 = ''; $tail16be = ''
        while (($read = $stream.Read($buffer, 0, $buffer.Length)) -gt 0) {
            $s8 = $tail8 + [System.Text.Encoding]::UTF8.GetString($buffer, 0, $read)
            $s16 = $tail16 + [System.Text.Encoding]::Unicode.GetString($buffer, 0, $read)
            $s16be = $tail16be + [System.Text.Encoding]::BigEndianUnicode.GetString($buffer, 0, $read)
            if ($s8 -match $script:CredentialPattern -or $s16 -match $script:CredentialPattern -or $s16be -match $script:CredentialPattern) { return $true }
            $tail8 = $s8.Substring([Math]::Max(0, $s8.Length - 2048))
            $tail16 = $s16.Substring([Math]::Max(0, $s16.Length - 2048))
            $tail16be = $s16be.Substring([Math]::Max(0, $s16be.Length - 2048))
        }
        return $false
    }
    finally { $stream.Dispose() }
}

function Test-FileSignature([string]$Path, [string]$Kind) {
    if ($Kind -ne 'mod-jar' -and $Kind -ne 'client-jar' -and $Kind -ne 'texture-png') { return $true }
    $stream = [System.IO.File]::OpenRead($Path)
    try {
        $bytes = New-Object byte[] 8
        $n = $stream.Read($bytes, 0, 8)
        if ($Kind -eq 'texture-png') { return ($n -eq 8 -and [BitConverter]::ToString($bytes) -eq '89-50-4E-47-0D-0A-1A-0A') }
        return ($n -ge 4 -and $bytes[0] -eq 80 -and $bytes[1] -eq 75 -and (($bytes[2] -eq 3 -and $bytes[3] -eq 4) -or ($bytes[2] -eq 5 -and $bytes[3] -eq 6)))
    }
    finally { $stream.Dispose() }
}

function Add-Candidate([System.IO.FileInfo]$File, [string]$Kind, [bool]$ScanText) {
    $rel = Get-RelativeClientPath $File.FullName
    if ($script:SeenCandidates.ContainsKey($rel)) { return }
    $script:SeenCandidates[$rel] = $true
    if ($rel -match $script:SensitiveNames) { Add-Exclusion $File.FullName 'sensitive-path-not-read'; return }
    if (Test-ReparsePoint $File) { Add-Exclusion $File.FullName 'symlink-or-junction-not-followed'; return }
    if (-not (Test-FileSignature $File.FullName $Kind)) { Add-Exclusion $File.FullName 'unexpected-file-signature'; return }
    if ($ScanText -and (Test-CredentialContent $File.FullName)) { Add-Exclusion $File.FullName 'credential-like-field-file-omitted'; return }
    $sha = (Get-FileHash -LiteralPath $File.FullName -Algorithm SHA256).Hash.ToLowerInvariant()
    $fresh = Get-Item -LiteralPath $File.FullName -Force
    $script:Candidates.Add([ordered]@{
        path = $rel
        kind = $Kind
        bytes = [long]$fresh.Length
        lastWriteUtc = $fresh.LastWriteTimeUtc.ToString('o')
        sha256 = $sha
    })
}

function Find-ClientFolders {
    $roots = New-Object 'System.Collections.Generic.List[string]'
    if ($ClientsRoot) { $roots.Add($ClientsRoot) }
    else {
        if ($env:APPDATA) { $roots.Add((Join-Path $env:APPDATA '.loliland/game-resources/clients')) }
        if ($env:USERPROFILE) { $roots.Add((Join-Path $env:USERPROFILE '.loliland/game-resources/clients')) }
    }
    $found = @{}
    foreach ($rootPath in @($roots | Select-Object -Unique)) {
        if (-not (Test-Path -LiteralPath $rootPath -PathType Container)) { continue }
        try { $safeRoot = Assert-PlainDirectory $rootPath } catch { Write-Warning $_.Exception.Message; continue }
        # Exact layout seen in the official launcher: clients/systemName/branch.
        # Do not read launcher-data/storage.txt to guess names or custom paths.
        foreach ($system in @(Get-ChildItem -LiteralPath $safeRoot -Directory -Force)) {
            if ((Test-ReparsePoint $system) -or $system.Name -match $script:SensitiveNames) { continue }
            foreach ($branch in @(Get-ChildItem -LiteralPath $system.FullName -Directory -Force)) {
                if ((Test-ReparsePoint $branch) -or $branch.Name -match $script:SensitiveNames) { continue }
                $mods = Join-Path $branch.FullName 'mods'
                if (Test-Path -LiteralPath $mods -PathType Container) {
                    $modsItem = Get-Item -LiteralPath $mods -Force
                    if (-not (Test-ReparsePoint $modsItem)) { $found[$branch.FullName] = $branch.FullName }
                }
            }
        }
    }
    return @($found.Values | Sort-Object)
}

function Select-ClientFolder {
    if ($ClientPath) { return $ClientPath }
    $choices = @(Find-ClientFolders)
    if ($NonInteractive) {
        if ($choices.Count -gt 0) { Write-Host ($choices -join [Environment]::NewLine) }
        throw 'Use -ClientPath with the exact TechnoMagic RPG branch folder containing mods. No profile is auto-selected.'
    }
    Write-Host ''
    Write-Host 'Выберите папку клиента TechnoMagic RPG. Файлы аккаунта не читаются.'
    for ($i = 0; $i -lt $choices.Count; $i++) { Write-Host (('[{0}] {1}' -f ($i + 1), $choices[$i])) }
    if ($choices.Count -eq 0) { Write-Host 'В стандартных расположениях папки клиентов не найдены.' }
    $answer = (Read-Host 'Номер нужной папки или полный путь к папке с mods; пустой ответ — отмена').Trim().Trim('"')
    if (-not $answer) { throw 'Cancelled; no archive was created.' }
    $number = 0
    if ([int]::TryParse($answer, [ref]$number) -and $number -ge 1 -and $number -le $choices.Count) { return $choices[$number - 1] }
    return $answer
}

function Write-JsonFile([string]$Path, $Value) {
    [System.IO.File]::WriteAllText($Path, ($Value | ConvertTo-Json -Depth 12), $script:Utf8)
}

function Close-ZipPart($State, [string]$CollectionId, [string]$CollectedAt, [long]$MaximumBytes) {
    if ($null -eq $State.Archive) { return }
    try {
        $manifest = [ordered]@{
            schema = 'loliland-client-input-part-v1'
            collectionId = $CollectionId
            collectedAt = $CollectedAt
            runtimeExport = $false
            serverSynchronizationVerified = $false
            partNumber = $State.Index
            entries = @($State.Entries.ToArray())
            note = 'Input collection only. File times are not evidence of current server recipes. payload entries are whole files; chunks require reconstruction by offset and SHA-256.'
        }
        $bytes = $script:Utf8.GetBytes(($manifest | ConvertTo-Json -Depth 12))
        $entry = $State.Archive.CreateEntry('part-manifest.json', [System.IO.Compression.CompressionLevel]::NoCompression)
        $es = $entry.Open()
        try { $es.Write($bytes, 0, $bytes.Length) } finally { $es.Dispose() }
    }
    finally {
        $State.Archive.Dispose(); $State.Stream.Dispose()
        $State.Archive = $null; $State.Stream = $null
    }
    $part = Get-Item -LiteralPath $State.Path
    if ($part.Length -gt $MaximumBytes) { throw 'Archive part exceeded the requested limit; collection aborted.' }
    $State.Completed.Add([ordered]@{ name = $part.Name; bytes = [long]$part.Length; sha256 = (Get-FileHash -LiteralPath $part.FullName -Algorithm SHA256).Hash.ToLowerInvariant() })
}

function Write-Archives([string]$Destination, $Inventory, [int]$PartMiB) {
    Add-Type -AssemblyName System.IO.Compression
    $maximumBytes = [long]$PartMiB * 1048576
    $reserveBytes = [long][Math]::Min(1048576, $maximumBytes / 4)
    $payloadLimit = $maximumBytes - $reserveBytes
    $state = [pscustomobject]@{ Archive = $null; Stream = $null; Path = ''; Index = 0; PayloadBytes = [long]0; Entries = $null; Completed = (New-Object 'System.Collections.Generic.List[object]') }
    $created = New-Object 'System.Collections.Generic.List[string]'
    $buffer = New-Object byte[] 65536
    $fileNumber = 0
    try {
        foreach ($file in $Inventory.files) {
            $fileNumber++
            $fullPath = Join-Path $script:ClientRoot ($file.path.Replace('/', [System.IO.Path]::DirectorySeparatorChar))
            $now = Get-Item -LiteralPath $fullPath -Force
            if (Test-ReparsePoint $now) { throw 'An input changed into a link after inventory.' }
            [void](Assert-PlainDirectory $now.DirectoryName)
            $source = [System.IO.File]::Open($fullPath, [System.IO.FileMode]::Open, [System.IO.FileAccess]::Read, [System.IO.FileShare]::Read)
            $fullHash = [System.Security.Cryptography.SHA256]::Create()
            try {
                if ($source.Length -ne $file.bytes) { throw "Input size changed. Close the game and rerun: $($file.path)" }
                $offset = [long]0; $chunkNumber = 0
                $chunkCount = [int][Math]::Max(1, [Math]::Ceiling($file.bytes / [double]$payloadLimit))
                do {
                    $chunkNumber++
                    $length = [long][Math]::Min($payloadLimit, $file.bytes - $offset)
                    if ($null -eq $state.Archive -or ($state.PayloadBytes + $length -gt $payloadLimit) -or $state.Entries.Count -ge 100) {
                        Close-ZipPart $state $Inventory.collectionId $Inventory.collectedAt $maximumBytes
                        $state.Index++; $state.PayloadBytes = [long]0
                        $state.Entries = New-Object 'System.Collections.Generic.List[object]'
                        $state.Path = Join-Path $Destination ('tmr-inputs-part{0:D3}.zip' -f $state.Index)
                        $state.Stream = [System.IO.File]::Open($state.Path, [System.IO.FileMode]::CreateNew, [System.IO.FileAccess]::Write, [System.IO.FileShare]::None)
                        $created.Add($state.Path)
                        $state.Archive = New-Object System.IO.Compression.ZipArchive($state.Stream, [System.IO.Compression.ZipArchiveMode]::Create, $false)
                    }
                    $entryName = 'payload/' + $file.path
                    if ($chunkCount -gt 1) { $entryName = 'chunks/{0:D6}/{1:D6}.bin' -f $fileNumber, $chunkNumber }
                    $entry = $state.Archive.CreateEntry($entryName, [System.IO.Compression.CompressionLevel]::NoCompression)
                    $output = $entry.Open()
                    $chunkHash = [System.Security.Cryptography.SHA256]::Create()
                    try {
                        $remaining = $length
                        while ($remaining -gt 0) {
                            $want = [int][Math]::Min($buffer.Length, $remaining)
                            $read = $source.Read($buffer, 0, $want)
                            if ($read -le 0) { throw 'An input file ended unexpectedly.' }
                            $output.Write($buffer, 0, $read)
                            [void]$fullHash.TransformBlock($buffer, 0, $read, $buffer, 0)
                            [void]$chunkHash.TransformBlock($buffer, 0, $read, $buffer, 0)
                            $remaining -= $read
                        }
                        [void]$chunkHash.TransformFinalBlock((New-Object byte[] 0), 0, 0)
                        $pieceHash = [BitConverter]::ToString($chunkHash.Hash).Replace('-','').ToLowerInvariant()
                    }
                    finally { $output.Dispose(); $chunkHash.Dispose() }
                    $state.Entries.Add([ordered]@{ entry = $entryName; path = $file.path; fileBytes = $file.bytes; fileSha256 = $file.sha256; offset = $offset; bytes = $length; sha256 = $pieceHash; chunk = $chunkNumber; chunks = $chunkCount })
                    $state.PayloadBytes += $length; $offset += $length
                } while ($offset -lt $file.bytes)
                [void]$fullHash.TransformFinalBlock((New-Object byte[] 0), 0, 0)
                $actualHash = [BitConverter]::ToString($fullHash.Hash).Replace('-','').ToLowerInvariant()
                if ($actualHash -ne $file.sha256) { throw "Input changed after inventory. Close the game and rerun: $($file.path)" }
            }
            finally { $source.Dispose(); $fullHash.Dispose() }
        }
        Close-ZipPart $state $Inventory.collectionId $Inventory.collectedAt $maximumBytes
        return @($state.Completed.ToArray())
    }
    catch {
        if ($null -ne $state.Archive) { $state.Archive.Dispose() }
        if ($null -ne $state.Stream) { $state.Stream.Dispose() }
        foreach ($path in $created) { if (Test-Path -LiteralPath $path) { Remove-Item -LiteralPath $path -Force } }
        throw
    }
}

try {
    Write-Host 'LoliLand TMR: локальный сборщик файлов для исследования рецептов.'
    Write-Host 'Он не входит в аккаунт, не запускает игру и ничего не отправляет в интернет.'
    $selected = Select-ClientFolder
    $script:ClientRoot = Assert-PlainDirectory $selected
    if (-not (Test-Path -LiteralPath (Join-Path $script:ClientRoot 'mods') -PathType Container)) { throw 'Select the exact client branch folder containing the mods folder.' }
    [void](Assert-PlainDirectory (Join-Path $script:ClientRoot 'mods'))
    Write-Host "Выбрана папка: $script:ClientRoot"
    Write-Host 'Проверка разрешённых JAR, скриптов, настроек рецептов, текстур и переводов. Расчёт SHA-256...'

    foreach ($file in @(Get-SafeFiles (Join-Path $script:ClientRoot 'mods'))) {
        if ($file.Extension -ieq '.jar') { Add-Candidate $file 'mod-jar' $false }
    }
    $baseJar = Join-Path $script:ClientRoot 'client.jar'
    if (Test-Path -LiteralPath $baseJar -PathType Leaf) { Add-Candidate (Get-Item -LiteralPath $baseJar -Force) 'client-jar' $false }
    foreach ($file in @(Get-SafeFiles (Join-Path $script:ClientRoot 'scripts'))) {
        if ($file.Extension -ieq '.zs') { Add-Candidate $file 'zenscript' $true }
    }
    foreach ($file in @(Get-SafeFiles (Join-Path $script:ClientRoot 'config'))) {
        $relative = Get-RelativeClientPath $file.FullName
        if ($file.Name -match '^scripts[-_.a-z0-9]*\.dat$') { Add-Candidate $file 'scripts-cache' $true }
        elseif ($file.Extension -ieq '.zs') { Add-Candidate $file 'zenscript' $true }
        elseif ($file.Extension -match '^\.(cfg|conf|ini|json|properties|toml|txt)$' -and $relative -match '(?i)(recipe|craft|modtweaker|oredict|loliindex|luminousui|^config/index[./_-])') { Add-Candidate $file 'recipe-config' $true }
    }
    foreach ($file in @(Get-ChildItem -LiteralPath $script:ClientRoot -File -Force)) {
        if ($file.Name -match '^scripts[-_.a-z0-9]*\.dat$') { Add-Candidate $file 'scripts-cache' $true }
    }
    foreach ($assetRoot in @('assets','resources/assets')) {
        foreach ($file in @(Get-SafeFiles (Join-Path $script:ClientRoot $assetRoot))) {
            $relative = Get-RelativeClientPath $file.FullName
            if ($relative -match '^(?:resources/)?assets/[a-z0-9_.-]+/textures/.+\.png$') { Add-Candidate $file 'texture-png' $false }
            elseif ($relative -match '^(?:resources/)?assets/[a-z0-9_.-]+/textures/.+\.png\.mcmeta$') { Add-Candidate $file 'texture-animation' $true }
            elseif ($relative -match '^(?:resources/)?assets/[a-z0-9_.-]+/lang/.+\.lang$') { Add-Candidate $file 'language' $true }
        }
    }

    $collectedAt = [DateTime]::UtcNow.ToString('o')
    $collectionId = 'tmr-inputs-' + [DateTime]::UtcNow.ToString('yyyyMMdd-HHmmss') + '-' + [Guid]::NewGuid().ToString('N').Substring(0,6)
    $files = @($script:Candidates.ToArray() | Sort-Object { $_.path })
    $totalBytes = [long]0
    foreach ($file in $files) { $totalBytes += $file.bytes }
    $inventory = [ordered]@{
        schema = 'loliland-client-inputs-v1'
        collectionId = $collectionId
        collectedAt = $collectedAt
        target = 'LoliLand TechnoMagic RPG; folder selected by user'
        runtimeExport = $false
        registryEnumerated = $false
        complete = $false
        recipesExported = 0
        serverSynchronizationVerified = $false
        clientFolderLabel = (Split-Path $script:ClientRoot -Leaf)
        totalFiles = $files.Count
        totalBytes = $totalBytes
        maximumArchivePartMiB = $MaxPartMiB
        files = $files
        exclusions = @($script:Excluded.ToArray())
        archives = @()
        notes = @(
            'This is an offline input collection, not an export of recipes or proof of freshness.',
            'collectedAt is the collection time. lastWriteUtc is only a filesystem timestamp.',
            'Game JARs contain textures and language assets; the collector never executes them.',
            'Launcher storage and account data, logs, saves, screenshots and servers.dat are not included.',
            'Only narrowly selected configs are included; files with credential-like fields are omitted whole.',
            'Symlinks and junctions are not followed. Archives are never uploaded automatically.',
            'Current server recipe synchronization and all Index handlers still require verification.'
        )
    }
    if (-not $OutputDirectory) {
        $outputBase = [Environment]::GetFolderPath('MyDocuments')
        if (-not $outputBase) { $outputBase = [Environment]::GetFolderPath('Desktop') }
        if (-not $outputBase) { $outputBase = (Get-Location).Path }
        $OutputDirectory = Join-Path $outputBase $collectionId
    }
    $OutputDirectory = [System.IO.Path]::GetFullPath($OutputDirectory)
    $clientPrefix = $script:ClientRoot + [System.IO.Path]::DirectorySeparatorChar
    if ($OutputDirectory.Equals($script:ClientRoot, $script:PathComparison) -or $OutputDirectory.StartsWith($clientPrefix, $script:PathComparison)) { throw 'Choose an output folder outside the game client.' }
    if (Test-Path -LiteralPath $OutputDirectory) { throw 'Output folder already exists. Choose a new folder to avoid overwriting any files.' }
    [void][System.IO.Directory]::CreateDirectory($OutputDirectory)
    $inventoryPath = Join-Path $OutputDirectory 'inventory.json'
    Write-JsonFile $inventoryPath $inventory
    Write-Host ''
    Write-Host ('Выбрано файлов: {0}; размер до упаковки: {1:N1} МиБ; исключено подозрительных файлов и ссылок: {2}.' -f $files.Count, ($totalBytes / 1048576), $script:Excluded.Count)
    Write-Host "Опись файлов: $inventoryPath"
    Write-Host "Размер каждой части ZIP — не больше $MaxPartMiB МиБ. Исходные файлы игры не изменяются."
    if ($files.Count -eq 0) { throw 'No allowed files found. Inventory saved; no ZIP created.' }
    $makeZip = [bool]$CreateZip
    if (-not $makeZip -and -not $NonInteractive) {
        $answer = Read-Host 'Создать ZIP из этих файлов? Напишите ДА или YES; Enter — закончить без архива'
        $makeZip = ($answer.Trim() -ieq 'YES' -or $answer.Trim() -eq ([string][char]0x0434 + [char]0x0430))
    }
    if ($makeZip) {
        $inventory.archives = @(Write-Archives $OutputDirectory $inventory $MaxPartMiB)
        Write-JsonFile $inventoryPath $inventory
        Write-Host ''
        Write-Host "Готово. Части ZIP и inventory.json находятся в папке: $OutputDirectory"
        Write-Host 'Прикрепите все файлы tmr-inputs-part*.zip и inventory.json в чат самостоятельно.'
        Write-Host ('Создано частей архива: {0}. Ничего не было отправлено в интернет.' -f $inventory.archives.Count)
    }
    else { Write-Host 'Создана только опись. Архивов нет. Для упаковки запустите скрипт снова и ответьте ДА.' }
}
catch {
    Write-Error -Message $_.Exception.Message -ErrorAction Continue
    if (-not $NonInteractive) { [void](Read-Host 'Ошибка. Нажмите Enter, чтобы закрыть скрипт') }
    exit 1
}
