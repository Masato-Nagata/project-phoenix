#Requires -Version 7.0
# Independent recomputation of `bundleSha256` (G2-C, design.md item 7a, hashRule `dist-bundle-sha256-v1`) with PowerShell only: Get-FileHash for the
# raw bytes of each file, the existing ConvertTo-CanonicalJson for the document, ASCII ordinal sorting, UTF-8 without BOM and without a final line feed.
# It never calls the TypeScript code. The expected values of packages/discovery-loop/test-vectors/bundle-hash/vector.json were fixed by THIS
# implementation (run once with -Generate); the TypeScript test compares its own result with them. It also checks that the PowerShell verification
# accepts the version-1 and version-2 vectors and the version-2 vector that carries a `bundleSha256` (the field is optional for the readers).
# Synthetic data in temporary directories only. No Docker, no network, no real Run.
param([switch]$Generate)
. (Join-Path $PSScriptRoot 'lib/testlib.ps1')
Import-Module (Join-Path $script:ToolsDir 'DiscoveryCommon.psm1') -Force -DisableNameChecking
$utf8 = [System.Text.UTF8Encoding]::new($false)
$vectorPath = Join-Path $script:RepoRoot 'packages/discovery-loop/test-vectors/bundle-hash/vector.json'
$vecDir = Join-Path $script:RepoRoot 'packages/discovery-loop/test-vectors'
$ordinal = [System.StringComparer]::Ordinal

function Write-VectorTree {
    param([string]$Base, $Tree, [switch]$Reverse)
    $roots = @($Tree.PSObject.Properties)
    if ($Reverse) { [Array]::Reverse($roots) }
    foreach ($prop in $roots) {
        $items = @($prop.Value); if ($Reverse) { [Array]::Reverse($items) }
        foreach ($f in $items) {
            $full = Join-Path $Base (($prop.Name + '/' + $f.path) -replace '/', [IO.Path]::DirectorySeparatorChar)
            [void][IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($full))
            [IO.File]::WriteAllBytes($full, [Convert]::FromBase64String([string]$f.base64))
        }
    }
}

# The collection: a directory named node_modules is listed and not entered; every other file is hashed from its raw bytes (Get-FileHash).
function Get-BundleEntries {
    param([string]$Dir, [string]$Rel, [System.Collections.Generic.List[object]]$Files, [System.Collections.Generic.List[string]]$Skipped)
    foreach ($e in (Get-ChildItem -LiteralPath $Dir -Force)) {
        $childRel = "$Rel/$($e.Name)"
        if ($e.PSIsContainer) {
            if ($e.Name -ceq 'node_modules') { $Skipped.Add($childRel); continue }
            Get-BundleEntries -Dir $e.FullName -Rel $childRel -Files $Files -Skipped $Skipped
        } else {
            $Files.Add([ordered]@{ path = $childRel; sha256 = (Get-FileHash -LiteralPath $e.FullName -Algorithm SHA256).Hash.ToLowerInvariant() })
        }
    }
}

function Get-IndependentBundle {
    param([string]$Base, [string[]]$Labels)
    $files = [System.Collections.Generic.List[object]]::new(); $skipped = [System.Collections.Generic.List[string]]::new()
    foreach ($l in $Labels) { Get-BundleEntries -Dir (Join-Path $Base ($l -replace '/', [IO.Path]::DirectorySeparatorChar)) -Rel $l -Files $files -Skipped $skipped }
    $rootsSorted = [string[]]$Labels.Clone(); [Array]::Sort($rootsSorted, $ordinal)
    $skippedSorted = $skipped.ToArray(); [Array]::Sort($skippedSorted, $ordinal)
    $byPath = @{}; foreach ($f in $files) { $byPath[$f.path] = $f }
    $paths = [string[]]@($files | ForEach-Object { $_.path }); [Array]::Sort($paths, $ordinal)
    $sorted = [System.Collections.Generic.List[object]]::new(); foreach ($p in $paths) { $sorted.Add([ordered]@{ path = $p; sha256 = $byPath[$p].sha256 }) }
    $doc = [ordered]@{ hashRule = 'dist-bundle-sha256-v1'; roots = [object[]]$rootsSorted; skippedDirectories = [object[]]$skippedSorted; files = $sorted }
    $text = ConvertTo-CanonicalJson -Value $doc
    $bytes = $utf8.GetBytes($text)
    $tmp = Join-Path ([IO.Path]::GetTempPath()) ('phx-bundle-' + [guid]::NewGuid().ToString('N') + '.bin')
    try { [IO.File]::WriteAllBytes($tmp, $bytes); $final = (Get-FileHash -LiteralPath $tmp -Algorithm SHA256).Hash.ToLowerInvariant() } finally { Remove-Item -LiteralPath $tmp -Force -ErrorAction SilentlyContinue }
    [pscustomobject]@{ Roots = $rootsSorted; Skipped = $skippedSorted; Files = $sorted; Text = $text; Bytes = $bytes; Sha256 = $final }
}

$vec = [IO.File]::ReadAllText($vectorPath) | ConvertFrom-Json
$labels = @($vec.tree.PSObject.Properties | ForEach-Object { $_.Name })
$base = New-TempDir
Write-VectorTree -Base $base -Tree $vec.tree
$r = Get-IndependentBundle -Base $base -Labels $labels

if ($Generate) {
    $expected = [ordered]@{
        roots = @($r.Roots); skippedDirectories = @($r.Skipped); files = @($r.Files | ForEach-Object { [pscustomobject]@{ path = $_.path; sha256 = $_.sha256 } })
        canonicalJson = $r.Text; canonicalJsonBytes = $r.Bytes.Length; bundleSha256 = $r.Sha256
    }
    $out = [ordered]@{ kind = $vec.kind; version = $vec.version; hashRule = $vec.hashRule; note = $vec.note; tree = $vec.tree; expected = $expected }
    [IO.File]::WriteAllText($vectorPath, (($out | ConvertTo-Json -Depth 12) + "`n"), $utf8)
    # the version-2 Run_Manifest that carries the hash (synthetic): the existing v2 vector plus one isolationChecks entry, written with the existing canonical JSON
    $src = Join-Path $vecDir 'sealed-run-v2'; $dst = Join-Path $vecDir 'sealed-run-v2-bundle-hash'
    if (Test-Path -LiteralPath $dst) { throw 'the target vector exists; it is not overwritten' }
    # Two forms are kept apart. The HASHED DOCUMENT of bundleSha256 is the canonical JSON with no final line feed (above). The MANIFEST FILE of an
    # existing Run is the canonical JSON plus exactly ONE line feed (the store's saved form): the file must equal those bytes exactly (no BOM, no CRLF,
    # no extra blank, no second line feed), and the new manifest is written in the same form.
    $srcBytes = [IO.File]::ReadAllBytes((Join-Path $src 'manifest.json'))
    $srcText = $utf8.GetString($srcBytes)
    $m = ConvertFrom-JsonStrict -Text $srcText.Substring(0, [Math]::Max(0, $srcText.Length - 1))
    $expectedSrcBytes = $utf8.GetBytes((ConvertTo-CanonicalJson -Value $m) + "`n")
    if (-not [System.Linq.Enumerable]::SequenceEqual($srcBytes, $expectedSrcBytes)) { throw 'the v2 manifest is not the canonical JSON plus exactly one line feed' }
    $m['isolationChecks'].Add([ordered]@{ id = 'import_analysis'; status = 'verified'; measuredBy = 'runtime'
            measured = [ordered]@{ bundleSha256 = $r.Sha256; filesScanned = [long]@($r.Files | Where-Object { $_.path -cmatch '\.(js|mjs|cjs)$' }).Count; filesTotal = [long]$r.Files.Count; findingCount = [long]0; textSha256 = (Get-Sha256HexOfText -Text 'synthetic-text-sha256') } })
    [void][IO.Directory]::CreateDirectory($dst)
    Copy-Item -LiteralPath (Join-Path $src 'records.jsonl') -Destination $dst
    Copy-Item -LiteralPath (Join-Path $src 'blobs') -Destination $dst -Recurse
    [IO.File]::WriteAllBytes((Join-Path $dst 'manifest.json'), $utf8.GetBytes((ConvertTo-CanonicalJson -Value $m) + "`n"))
    Write-Host "generated: bundleSha256=$($r.Sha256) files=$($r.Files.Count) skipped=$($r.Skipped.Count)"
    exit 0
}

Invoke-TestMain {
    Write-Host '=== bundleSha256: independent PowerShell recomputation (G2-C) ===' -ForegroundColor Cyan
    $e = $vec.expected
    Test-Case 'vector: the four roots, in ASCII ordinal order' ((@($r.Roots) -join ',') -ceq 'packages/ai-client/dist,packages/analyzer/dist,packages/discovery-loop/dist,packages/verifier/dist' -and (@($e.roots) -join ',') -ceq (@($r.Roots) -join ','))
    Test-Case 'vector: the skipped directories are the two node_modules directories (listed with the root label, not entered)' ((@($r.Skipped) -join ',') -ceq 'packages/ai-client/dist/node_modules,packages/discovery-loop/dist/node_modules' -and (@($e.skippedDirectories) -join ',') -ceq (@($r.Skipped) -join ','))
    $anaOrder = @($r.Files | ForEach-Object { $_.path } | Where-Object { $_ -clike 'packages/analyzer/dist/*' } | ForEach-Object { $_.Substring('packages/analyzer/dist/'.Length) })
    Test-Case 'order: ASCII ordinal order of the paths (0 < B < a; then + - . / @ _ after a; a.b.js < a.js < a/b.js), written down by hand' ((($anaOrder) -join ',') -ceq '0.js,B.js,a+b.js,a-b.js,a.b.js,a.js,a/b.js,a@b.js,a_b.js,index.js') ($anaOrder -join ',')
    Test-Case 'order: the same names in different roots do not collide (index.js appears under each of the four roots)' (@($r.Files | Where-Object { $_.path -clike '*/dist/index.js' }).Count -eq 4)
    $allPaths = @($r.Files | ForEach-Object { $_.path }); $sortedCopy = [string[]]$allPaths.Clone(); [Array]::Sort($sortedCopy, $ordinal)
    Test-Case 'order: the whole file list is already in ASCII ordinal order, with no duplicate and no excluded file' (($allPaths -join "`n") -ceq ($sortedCopy -join "`n") -and @($allPaths | Select-Object -Unique).Count -eq $allPaths.Count -and -not ($allPaths -match 'node_modules'))
    Test-Case 'files: the path and the SHA-256 of every file equal the fixed expectation' ((($r.Files | ForEach-Object { "$($_.path) $($_.sha256)" }) -join "`n") -ceq (($e.files | ForEach-Object { "$($_.path) $($_.sha256)" }) -join "`n"))
    $emptyHash = @($r.Files | Where-Object { $_.path -ceq 'packages/verifier/dist/empty.js' })[0].sha256
    Test-Case 'files: the empty file has the well-known SHA-256 of zero bytes (a constant that no code of this repository produces)' ($emptyHash -ceq 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855')
    $crlf = @($r.Files | Where-Object { $_.path -ceq 'packages/verifier/dist/crlf.js' })[0].sha256
    Test-Case 'files: raw bytes: a file with CRLF is hashed as it is (not normalized)' ($crlf -ceq (Get-Sha256Hex -Bytes ([byte[]](0x61, 0x0d, 0x0a, 0x62, 0x0a))) -and $crlf -cne (Get-Sha256Hex -Bytes ([byte[]](0x61, 0x0a, 0x62, 0x0a))))
    $badA = @($r.Files | Where-Object { $_.path -ceq 'packages/verifier/dist/bad-a.js' })[0].sha256; $badB = @($r.Files | Where-Object { $_.path -ceq 'packages/verifier/dist/bad-b.js' })[0].sha256
    Test-Case 'files: two different invalid UTF-8 byte sequences (which decode to the same text) have different file hashes' ($badA -cne $badB)
    Test-Case 'document: the canonical JSON text equals the fixed expectation, has the four keys in canonical order, and its byte count is the expected one' ($r.Text -ceq $e.canonicalJson -and $r.Text.StartsWith('{"files":[{"path":"packages/ai-client/dist/index.js","sha256":"') -and $r.Text.Contains('"hashRule":"dist-bundle-sha256-v1","roots":["packages/ai-client/dist",') -and $r.Bytes.Length -eq [int]$e.canonicalJsonBytes)
    $first3 = $r.Bytes[0..2]
    Test-Case 'document: UTF-8 without a byte-order mark and without a final line feed' (-not ($first3[0] -eq 0xEF -and $first3[1] -eq 0xBB -and $first3[2] -eq 0xBF) -and $r.Bytes[$r.Bytes.Length - 1] -ne 0x0A -and $r.Text.EndsWith('}'))
    Test-Case 'result: the final bundleSha256 equals the fixed expectation (64 lowercase hexadecimal characters)' ($r.Sha256 -ceq $e.bundleSha256 -and $r.Sha256 -cmatch '^[0-9a-f]{64}$')

    # sensitivity (each variant on its own copy of the tree)
    function Get-Variant { param([scriptblock]$Mutate, [switch]$Reverse) $b = New-TempDir; Write-VectorTree -Base $b -Tree $vec.tree -Reverse:$Reverse; if ($Mutate) { & $Mutate $b }; (Get-IndependentBundle -Base $b -Labels $labels).Sha256 }
    $p = { param($b, $rel) Join-Path $b ($rel -replace '/', [IO.Path]::DirectorySeparatorChar) }
    Test-Case 'same tree, files created in the opposite order: the same bundleSha256' ((Get-Variant -Reverse) -ceq $r.Sha256)
    $v1 = Get-Variant { param($b) $f = & $p $b 'packages/analyzer/dist/index.js'; $x = [IO.File]::ReadAllBytes($f); $x[0] = $x[0] -bxor 1; [IO.File]::WriteAllBytes($f, $x) }
    Test-Case 'a change of one byte changes the hash' ($v1 -cne $r.Sha256)
    $v2 = Get-Variant { param($b) Move-Item -LiteralPath (& $p $b 'packages/analyzer/dist/a.js') -Destination (& $p $b 'packages/analyzer/dist/c.js') }
    Test-Case 'a renamed file changes the hash' ($v2 -cne $r.Sha256)
    $v3 = Get-Variant { param($b) [IO.File]::WriteAllText((& $p $b 'packages/analyzer/dist/new.js'), 'x') }
    $v4 = Get-Variant { param($b) Remove-Item -LiteralPath (& $p $b 'packages/analyzer/dist/0.js') }
    Test-Case 'an added file and a removed file each change the hash (and differ from each other)' ($v3 -cne $r.Sha256 -and $v4 -cne $r.Sha256 -and $v3 -cne $v4)
    $changed = @(foreach ($rel in 'packages/discovery-loop/dist/data.json', 'packages/discovery-loop/dist/types.d.ts', 'packages/discovery-loop/dist/index.js.map', 'packages/verifier/dist/bin/native.node', 'packages/verifier/dist/bin/mod.wasm') {
            $relCopy = $rel; Get-Variant { param($b) $f = & $p $b $relCopy; $x = [IO.File]::ReadAllBytes($f); $x[$x.Length - 1] = $x[$x.Length - 1] -bxor 1; [IO.File]::WriteAllBytes($f, $x) } })
    Test-Case 'a change in a JSON, a type definition, a source map, a .node or a .wasm file is detected' (@($changed | Where-Object { $_ -cne $r.Sha256 }).Count -eq 5 -and @($changed | Select-Object -Unique).Count -eq 5)
    $v5 = Get-Variant { param($b) Remove-Item -LiteralPath (& $p $b 'packages/discovery-loop/dist/node_modules') -Recurse }
    $v6 = Get-Variant { param($b) [void][IO.Directory]::CreateDirectory((& $p $b 'packages/verifier/dist/node_modules')) }
    $v7 = Get-Variant { param($b) [IO.File]::WriteAllText((& $p $b 'packages/ai-client/dist/node_modules/dep/index.js'), 'a different file inside an excluded directory') }
    Test-Case 'the set of excluded directories is part of the hash (one removed, one added); the content inside an excluded directory is not' ($v5 -cne $r.Sha256 -and $v6 -cne $r.Sha256 -and $v5 -cne $v6 -and $v7 -ceq $r.Sha256)

    # the readers accept a Run with and without the field (task 4.14 requires it later; the readers do not)
    foreach ($name in 'sealed-run', 'sealed-run-v2', 'sealed-run-v2-bundle-hash') {
        $src = Join-Path $vecDir $name
        $dir = Join-Path (New-TempDir) 'run'; Copy-Item -LiteralPath $src -Destination $dir -Recurse
        $before = Test-CompletedRun -Path $dir
        $v = Test-RunDirectory -Path $dir
        [IO.File]::WriteAllText((Join-Path $dir 'COMPLETE'), (Get-Sha256HexOfFile -Path (Join-Path $dir 'manifest.json')))
        $after = Test-CompletedRun -Path $dir
        [IO.File]::WriteAllText((Join-Path $dir 'COMPLETE'), ('0' * 64))
        $wrong = Test-CompletedRun -Path $dir
        Test-Case "readers: the PowerShell verification accepts $name with a Completion_Marker, and not without one or with a wrong one" ($v.Result -eq 'success' -and -not $before -and $after -and -not $wrong)
    }
    $withHash = [IO.File]::ReadAllText((Join-Path $vecDir 'sealed-run-v2-bundle-hash/manifest.json'))
    Test-Case 'readers: the manifest vector carries the fixed bundleSha256 in the import_analysis entry of isolationChecks, and stays schemaVersion 2' ($withHash.Contains('"bundleSha256":"' + $e.bundleSha256 + '"') -and $withHash.Contains('"schemaVersion":2'))
    $old1 = [IO.File]::ReadAllText((Join-Path $vecDir 'sealed-run/manifest.json')); $old2 = [IO.File]::ReadAllText((Join-Path $vecDir 'sealed-run-v2/manifest.json'))
    Test-Case 'readers: the earlier version-1 and version-2 manifests have no bundleSha256 (they are still accepted above)' (-not $old1.Contains('bundleSha256') -and -not $old2.Contains('bundleSha256'))
}