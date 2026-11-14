#Requires -Version 7.0
# Shared host-side helpers of the AI_Discovery_Loop tools (tasks 2.18, 2.21, 2.25, 2.27): canonical JSON, a strict JSON reader,
# SHA-256, and the read-only verification of a Run directory. No function here opens a file for writing, and none calls Docker.
#
# Canonical JSON follows the design ("Canonical JSON"): UTF-8, keys sorted by UTF-16 code unit, no white space, the shortest
# standard string escapes, integers in plain decimal, no -0, lone surrogates and non-integer numbers refused. Records of the
# host tools hold strings, booleans, and integers only, which keeps this writer small. The TypeScript writer is the reference;
# the golden vectors of task 1.16 are the shared test.
Set-StrictMode -Version Latest

$script:Utf8 = [System.Text.UTF8Encoding]::new($false)
$script:Utf8Strict = [System.Text.UTF8Encoding]::new($false, $true)
$script:MaxSafeInteger = 9007199254740991

function Get-Sha256Hex {
    param([Parameter(Mandatory)][AllowEmptyCollection()][byte[]]$Bytes)
    $sha = [System.Security.Cryptography.SHA256]::Create()
    try { [Convert]::ToHexString($sha.ComputeHash($Bytes)).ToLowerInvariant() } finally { $sha.Dispose() }
}

function Get-Sha256HexOfText {
    param([Parameter(Mandatory)][AllowEmptyString()][string]$Text)
    Get-Sha256Hex -Bytes $script:Utf8.GetBytes($Text)
}

function Get-Sha256HexOfFile {
    param([Parameter(Mandatory)][string]$Path)
    $stream = [System.IO.File]::Open($Path, [System.IO.FileMode]::Open, [System.IO.FileAccess]::Read, [System.IO.FileShare]::ReadWrite)
    try {
        $sha = [System.Security.Cryptography.SHA256]::Create()
        try { [Convert]::ToHexString($sha.ComputeHash($stream)).ToLowerInvariant() } finally { $sha.Dispose() }
    } finally { $stream.Dispose() }
}

function Write-CanonicalString {
    param([string]$Value, [System.Text.StringBuilder]$Builder)
    [void]$Builder.Append('"')
    for ($i = 0; $i -lt $Value.Length; $i++) {
        $c = $Value[$i]
        $n = [int]$c
        if ($n -ge 0xD800 -and $n -le 0xDBFF) {
            if ($i + 1 -lt $Value.Length -and [int]$Value[$i + 1] -ge 0xDC00 -and [int]$Value[$i + 1] -le 0xDFFF) {
                [void]$Builder.Append($c).Append($Value[$i + 1]); $i++; continue
            }
            throw 'canonical json: lone high surrogate'
        }
        if ($n -ge 0xDC00 -and $n -le 0xDFFF) { throw 'canonical json: lone low surrogate' }
        switch ($n) {
            0x22 { [void]$Builder.Append('\"'); continue }
            0x5C { [void]$Builder.Append('\\'); continue }
            0x08 { [void]$Builder.Append('\b'); continue }
            0x09 { [void]$Builder.Append('\t'); continue }
            0x0A { [void]$Builder.Append('\n'); continue }
            0x0C { [void]$Builder.Append('\f'); continue }
            0x0D { [void]$Builder.Append('\r'); continue }
            default {
                if ($n -lt 0x20) { [void]$Builder.Append('\u').Append($n.ToString('x4', [System.Globalization.CultureInfo]::InvariantCulture)) }
                else { [void]$Builder.Append($c) }
            }
        }
    }
    [void]$Builder.Append('"')
}

function Write-CanonicalValue {
    param($Value, [System.Text.StringBuilder]$Builder, [int]$Depth)
    if ($Depth -gt 64) { throw 'canonical json: nesting too deep' }
    if ($null -eq $Value) { [void]$Builder.Append('null'); return }
    if ($Value -is [bool]) { [void]$Builder.Append($(if ($Value) { 'true' } else { 'false' })); return }
    if ($Value -is [string]) { Write-CanonicalString -Value $Value -Builder $Builder; return }
    if ($Value -is [int] -or $Value -is [long] -or $Value -is [int16] -or $Value -is [byte] -or $Value -is [uint16] -or $Value -is [uint32]) {
        $l = [long]$Value
        if ([Math]::Abs($l) -gt $script:MaxSafeInteger) { throw 'canonical json: integer outside the safe range' }
        [void]$Builder.Append($l.ToString([System.Globalization.CultureInfo]::InvariantCulture)); return
    }
    if ($Value -is [double] -or $Value -is [decimal] -or $Value -is [float]) {
        $d = [double]$Value
        if ([double]::IsFinite($d) -and $d -eq [Math]::Floor($d) -and [Math]::Abs($d) -le $script:MaxSafeInteger) {
            [void]$Builder.Append(([long]$d).ToString([System.Globalization.CultureInfo]::InvariantCulture)); return
        }
        throw 'canonical json: a non-integer number is not supported by the host tools'
    }
    if ($Value -is [System.Collections.IDictionary]) {
        $keys = [System.Collections.Generic.List[string]]::new()
        foreach ($k in $Value.Keys) { $keys.Add([string]$k) }
        $keys.Sort([System.StringComparer]::Ordinal)
        [void]$Builder.Append('{')
        $first = $true
        foreach ($k in $keys) {
            if (-not $first) { [void]$Builder.Append(',') }
            $first = $false
            Write-CanonicalString -Value $k -Builder $Builder
            [void]$Builder.Append(':')
            Write-CanonicalValue -Value $Value[$k] -Builder $Builder -Depth ($Depth + 1)
        }
        [void]$Builder.Append('}'); return
    }
    if ($Value -is [System.Collections.IEnumerable]) {
        [void]$Builder.Append('[')
        $first = $true
        foreach ($x in $Value) {
            if (-not $first) { [void]$Builder.Append(',') }
            $first = $false
            Write-CanonicalValue -Value $x -Builder $Builder -Depth ($Depth + 1)
        }
        [void]$Builder.Append(']'); return
    }
    throw "canonical json: $($Value.GetType().FullName) is not a JSON value"
}

function ConvertTo-CanonicalJson {
    [CmdletBinding()]
    param([Parameter(Mandatory)][AllowNull()]$Value)
    $sb = [System.Text.StringBuilder]::new()
    Write-CanonicalValue -Value $Value -Builder $sb -Depth 0
    $sb.ToString()
}

function Convert-JsonElement {
    param([System.Text.Json.JsonElement]$Element)
    switch ($Element.ValueKind) {
        'Object' {
            $o = [ordered]@{}
            foreach ($p in $Element.EnumerateObject()) {
                if ($o.Contains($p.Name)) { throw "duplicate key '$($p.Name)'" }
                $o[$p.Name] = Convert-JsonElement -Element $p.Value
            }
            return $o
        }
        'Array' {
            $list = [System.Collections.Generic.List[object]]::new()
            foreach ($x in $Element.EnumerateArray()) { $list.Add((Convert-JsonElement -Element $x)) }
            return , $list
        }
        'String' { return $Element.GetString() }
        'True' { return $true }
        'False' { return $false }
        'Null' { return $null }
        'Number' {
            $l = [long]0
            if ($Element.TryGetInt64([ref]$l)) { return $l }
            return $Element.GetDouble()
        }
        default { throw "unsupported JSON value kind $($Element.ValueKind)" }
    }
}

# Parses JSON text into ordered dictionaries, lists, strings, booleans, longs, and doubles. A duplicate key, a depth above 64,
# or text that is not JSON throws. Dates are NOT converted (ConvertFrom-Json would turn an ISO timestamp into a DateTime).
function ConvertFrom-JsonStrict {
    [CmdletBinding()]
    param([Parameter(Mandatory)][AllowEmptyString()][string]$Text)
    $opts = [System.Text.Json.JsonDocumentOptions]::new()
    $opts.MaxDepth = 64
    $doc = [System.Text.Json.JsonDocument]::Parse($Text, $opts)
    try { Convert-JsonElement -Element $doc.RootElement } finally { $doc.Dispose() }
}

# The text of a line that is canonical JSON: it parses, and writing the parsed value back gives the same text.
function Test-CanonicalText {
    param([string]$Text)
    try {
        $v = ConvertFrom-JsonStrict -Text $Text
        return ((ConvertTo-CanonicalJson -Value $v) -ceq $Text)
    } catch { return $false }
}

function Get-CodePointCount {
    param([string]$Text)
    $n = 0
    for ($i = 0; $i -lt $Text.Length; $i++) {
        $n++
        if ([char]::IsHighSurrogate($Text[$i]) -and $i + 1 -lt $Text.Length -and [char]::IsLowSurrogate($Text[$i + 1])) { $i++ }
    }
    $n
}

# JavaScript's \s set, so that a rationale is judged as the TypeScript schema judges it (.NET \s differs at U+0085 and U+FEFF).
function Test-HasNonJsWhitespace {
    param([string]$Text)
    foreach ($c in $Text.ToCharArray()) {
        $n = [int]$c
        $ws = ($n -ge 0x09 -and $n -le 0x0D) -or $n -eq 0x20 -or $n -eq 0xA0 -or $n -eq 0x1680 -or ($n -ge 0x2000 -and $n -le 0x200A) -or $n -eq 0x2028 -or $n -eq 0x2029 -or $n -eq 0x202F -or $n -eq 0x205F -or $n -eq 0x3000 -or $n -eq 0xFEFF
        if (-not $ws) { return $true }
    }
    $false
}

function Test-SafeRelativePath {
    param([string]$Path)
    if ([string]::IsNullOrEmpty($Path) -or $Path.Contains('\') -or $Path.Contains([char]0) -or $Path.StartsWith('/')) { return $false }
    foreach ($s in $Path.Split('/')) { if ($s -in '', '.', '..') { return $false } }
    $true
}

# ---------------------------------------------------------------------------------------------------------------------
# Read-only verification of a Run directory (design: "Verification operation (read-only)"; R12.9 to R12.11, R12.23).
# A Run_Volume copy, an Incoming_Export, or a completed Run directory. It opens files for reading only and never creates,
# renames, or removes anything (R12.10).
#
# Limits: the Run_Manifest is checked for the structure this verification needs (artifacts and chain); the full run-manifest
# schema is checked by the TypeScript readers (acceptRun), which re-verify independently when they read the Run.
# The chain walk hashes the stored text of each record without its `hash` member. Records are written in canonical form, in
# which `hash` is the first key, so the text after `"hash":"<hex>",` is the canonical text of the record without `hash`.
# A record that is not in that form is a chain break (fail closed).
$script:GenesisHash = '0' * 64
$script:UnlistedOk = @('manifest.json', 'COMPLETE', 'REASON.json')

function Get-RelativeFiles {
    param([string]$Root)
    $rootFull = [System.IO.Path]::GetFullPath($Root).TrimEnd('\', '/')
    $out = [System.Collections.Generic.List[string]]::new()
    if (-not (Test-Path -LiteralPath $rootFull -PathType Container)) { return , $out }
    foreach ($item in Get-ChildItem -LiteralPath $rootFull -Recurse -Force -File) {
        $rel = $item.FullName.Substring($rootFull.Length + 1).Replace('\', '/')
        $out.Add($rel)
    }
    , $out
}

function Add-BlobRefs {
    param($Element, [System.Collections.Generic.HashSet[string]]$Set)
    if ($Element.ValueKind -eq 'Object') {
        foreach ($p in $Element.EnumerateObject()) {
            if ($p.Name -ceq 'blob' -and $p.Value.ValueKind -eq 'String' -and $p.Value.GetString() -cmatch '^[0-9a-f]{64}$') { [void]$Set.Add($p.Value.GetString()) }
            Add-BlobRefs -Element $p.Value -Set $Set
        }
    } elseif ($Element.ValueKind -eq 'Array') {
        foreach ($x in $Element.EnumerateArray()) { Add-BlobRefs -Element $x -Set $Set }
    }
}

function Test-RunDirectory {
    [CmdletBinding()]
    param([Parameter(Mandatory)][string]$Path, [switch]$RequireMarker)
    $incomplete = {
        param($reason, $detail, $sha)
        [pscustomobject]@{ Result = 'failure'; Incomplete = $true; IncompleteReason = $reason; Detail = $detail; Mismatches = @(); ManifestSha256 = $sha }
    }
    $manifestPath = Join-Path $Path 'manifest.json'
    if (-not (Test-Path -LiteralPath $manifestPath -PathType Leaf)) { return (& $incomplete 'no_manifest' $null $null) }
    $manifestBytes = [System.IO.File]::ReadAllBytes($manifestPath)
    $manifestSha = Get-Sha256Hex -Bytes $manifestBytes
    $markerPath = Join-Path $Path 'COMPLETE'
    $markerText = if (Test-Path -LiteralPath $markerPath -PathType Leaf) { [System.IO.File]::ReadAllText($markerPath) } else { $null }
    if ($RequireMarker -and $null -eq $markerText) { return (& $incomplete 'no_completion_marker' $null $manifestSha) }

    try {
        $manifest = ConvertFrom-JsonStrict -Text $script:Utf8Strict.GetString($manifestBytes)
        if ($manifest -isnot [System.Collections.IDictionary]) { throw 'the manifest is not an object' }
        $artifacts = $manifest['artifacts']
        $chain = $manifest['chain']
        if ($null -eq $artifacts -or $artifacts -isnot [System.Collections.IEnumerable] -or $artifacts -is [string]) { throw 'artifacts is not a list' }
        if ($chain -isnot [System.Collections.IDictionary] -or $chain['records'] -isnot [long] -or $chain['lastHash'] -isnot [string] -or $chain['lastHash'] -cnotmatch '^[0-9a-f]{64}$') { throw 'chain is not valid' }
        $listed = @{}
        foreach ($a in $artifacts) {
            if ($a -isnot [System.Collections.IDictionary] -or $a['path'] -isnot [string] -or $a['sha256'] -isnot [string] -or $a['sha256'] -cnotmatch '^[0-9a-f]{64}$') { throw 'an artifact entry is not valid' }
            if (-not (Test-SafeRelativePath -Path $a['path'])) { throw 'artifact path is not a safe relative path' }
            if ($script:UnlistedOk -contains $a['path']) { throw "artifact list names $($a['path'])" }
            if ($listed.ContainsKey($a['path'])) { throw 'artifact path listed twice' }
            $listed[$a['path']] = $a['sha256']
        }
    } catch {
        return (& $incomplete 'manifest_invalid' $_.Exception.Message $manifestSha)
    }

    $found = @{}
    $flag = { param($where, $kind) $found["$kind`0$where"] = [pscustomobject]@{ Where = $where; Kind = $kind } }

    # 2. the hash of every listed artifact
    foreach ($rel in $listed.Keys) {
        $full = Join-Path $Path $rel
        if (-not (Test-Path -LiteralPath $full -PathType Leaf)) { & $flag $rel 'missing'; continue }
        $h = Get-Sha256HexOfFile -Path $full
        if ($h -cne $listed[$rel]) { & $flag $rel 'modified' }
        elseif ($rel.StartsWith('blobs/') -and $rel -cne "blobs/$($listed[$rel])") { & $flag $rel 'modified' }
    }
    # 3. files present but not listed
    foreach ($rel in (Get-RelativeFiles -Root $Path)) {
        if ($listed.ContainsKey($rel)) { continue }
        if (-not $rel.Contains('/') -and ($script:UnlistedOk -contains $rel)) { continue }
        & $flag $rel 'unlisted'
    }
    # 4. the hash chain
    $blobRefs = [System.Collections.Generic.HashSet[string]]::new()
    $count = 0
    $lastStored = $script:GenesisHash
    $recordsPath = Join-Path $Path 'records.jsonl'
    if (Test-Path -LiteralPath $recordsPath -PathType Leaf) {
        $text = $script:Utf8.GetString([System.IO.File]::ReadAllBytes($recordsPath))
        $lines = [System.Collections.Generic.List[string]]($text.Split("`n"))
        if ($lines[$lines.Count - 1] -eq '') { $lines.RemoveAt($lines.Count - 1) }
        elseif ($lines.Count -gt 0) { & $flag ('rec-{0:D6}' -f $lines.Count) 'chain_break' }
        $prev = $script:GenesisHash
        for ($i = 0; $i -lt $lines.Count; $i++) {
            $n = $i + 1
            $expectedId = 'rec-{0:D6}' -f $n
            $count = $n
            $line = $lines[$i]
            $doc = $null
            try {
                $opts = [System.Text.Json.JsonDocumentOptions]::new(); $opts.MaxDepth = 64
                $doc = [System.Text.Json.JsonDocument]::Parse($line, $opts)
                $root = $doc.RootElement
                $ok = $root.ValueKind -eq 'Object'
                $hash = $null; $id = $null; $prevHash = $null; $seq = [long]-1
                # Top-level properties by name; PowerShell cannot bind JsonElement.TryGetProperty's out parameter, and a
                # duplicate key fails closed (chain_break).
                $props = @{}
                if ($ok) {
                    foreach ($prop in $root.EnumerateObject()) {
                        if ($props.ContainsKey($prop.Name)) { $ok = $false; break }
                        $props[$prop.Name] = $prop.Value
                    }
                }
                if ($ok) {
                    if ($props.ContainsKey('hash') -and $props['hash'].ValueKind -eq 'String') { $hash = $props['hash'].GetString() }
                    if ($props.ContainsKey('id') -and $props['id'].ValueKind -eq 'String') { $id = $props['id'].GetString() }
                    if ($props.ContainsKey('prevHash') -and $props['prevHash'].ValueKind -eq 'String') { $prevHash = $props['prevHash'].GetString() }
                    if ($props.ContainsKey('seq') -and $props['seq'].ValueKind -eq 'Number') {
                        $sv = [long]0
                        if ($props['seq'].TryGetInt64([ref]$sv)) { $seq = $sv }
                    }
                }
                if (-not $ok -or $seq -ne $n -or $id -cne $expectedId -or $null -eq $hash -or $null -eq $prevHash -or $prevHash -cne $prev) {
                    & $flag $expectedId 'chain_break'
                } else {
                    $prefix = '{"hash":"' + $hash + '",'
                    $recomputed = $null
                    if ($line.StartsWith($prefix, [StringComparison]::Ordinal)) { $recomputed = Get-Sha256HexOfText -Text ('{' + $line.Substring($prefix.Length)) }
                    if ($recomputed -cne $hash) { & $flag $expectedId 'chain_break' }
                    if ($props.ContainsKey('payload')) { Add-BlobRefs -Element $props['payload'] -Set $blobRefs }
                }
                if ($ok -and $null -ne $hash) { $prev = $hash; $lastStored = $hash }
            } catch {
                & $flag $expectedId 'chain_break'
            } finally { if ($null -ne $doc) { $doc.Dispose() } }
        }
    }
    if ([long]$chain['records'] -ne $count) { & $flag 'manifest.chain' 'chain_break' }
    elseif ($chain['lastHash'] -cne $lastStored) { & $flag 'manifest.chain' 'chain_break' }
    # 5. every blob reference resolves to a listed blob
    foreach ($b in $blobRefs) { if (-not $listed.ContainsKey("blobs/$b")) { & $flag "blobs/$b" 'missing' } }

    $mismatches = @($found.Values | Sort-Object -Property @{ Expression = { $_.Where }; Ascending = $true }, @{ Expression = { $_.Kind }; Ascending = $true })
    [pscustomobject]@{
        Result = $(if ($mismatches.Count -eq 0) { 'success' } else { 'failure' })
        Incomplete = $false; IncompleteReason = $null; Detail = $null; Mismatches = $mismatches; ManifestSha256 = $manifestSha
    }
}

# The acceptance rule of a completed Run directory (R12.23): COMPLETE exists, its content equals the SHA-256 of manifest.json,
# and verification succeeds. Anything else is incomplete.
function Test-CompletedRun {
    [CmdletBinding()]
    param([Parameter(Mandatory)][string]$Path)
    $r = Test-RunDirectory -Path $Path -RequireMarker
    if ($r.Incomplete -or $r.Result -ne 'success') { return $false }
    $marker = ([System.IO.File]::ReadAllText((Join-Path $Path 'COMPLETE'))) -replace '\r?\n$', ''
    $marker -ceq $r.ManifestSha256
}

Export-ModuleMember -Function Get-Sha256Hex, Get-Sha256HexOfText, Get-Sha256HexOfFile, ConvertTo-CanonicalJson, ConvertFrom-JsonStrict, Test-CanonicalText, Get-CodePointCount, Test-HasNonJsWhitespace, Test-SafeRelativePath, Test-RunDirectory, Test-CompletedRun