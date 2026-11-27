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

# ---------------------------------------------------------------------------------------------------------------------
# Bounded verification support (task 4.10, part B3a). Everything below is used by Test-RunDirectory only, and only the reader
# (Read-RunFile) is used in both modes. Without -Bounded nothing here limits or rejects anything: the limits are $null.
#
# What the bounds guarantee, and what they do not:
# - The raw bytes that the verification reads from manifest.json, COMPLETE, records.jsonl and every artifact are counted AS THEY ARE READ
#   (the stream length is never trusted), against one total and against a limit per file. Reading stops one byte past the limit; that one
#   byte is counted, and the verification fails. This is a budget of raw bytes read, not a limit on the memory of the process.
# - The enumeration counts entries (files and directories) while it walks, and stops at the first entry above the limit.
# - A reparse point (symbolic link, junction, mount point) is refused before it is entered or opened. The check and the open are two steps:
#   a replacement in between, a hard link, a subst or mapped drive, and a changed ancestor after the check are NOT detected.
#   The time-of-check to time-of-use gap is reduced, not closed.
# A failure of a bound is a failed verification with a fixed reason code. No partial hash or partial result is returned as a success.
$script:RunBoundDefaults = [pscustomobject]@{
    MaxTotalBytes    = [long](64 * 1024 * 1024)   # one verification (design: replay input budget, 64 MiB)
    MaxManifestBytes = [long](4 * 1024 * 1024)    # TypeScript MAX_MANIFEST_BYTES
    MaxMarkerBytes   = [long]128                  # COMPLETE is 64 hex characters, optionally CRLF (66 bytes); 128 leaves room for a BOM
    MaxEntries       = [long]10000                # files + directories; the contract has no limit (see the design note)
    MaxDepth         = [long]16                   # TypeScript MAX_WALK_DEPTH
}

function Stop-RunBound {
    param([string]$Code)
    throw [System.InvalidOperationException]::new("RUNBOUND:$Code")
}

# An int or long between $Min and Int64.MaxValue - 1 (so that limit + 1 and used + count cannot overflow), or the default when $null.
function Resolve-RunBound {
    param($Value, [string]$Name, [long]$Default, [long]$Min = 1)
    if ($null -eq $Value) { return $Default }
    if ($Value -isnot [int] -and $Value -isnot [long]) { throw [System.ArgumentException]::new("$Name must be an integer (int or long)") }
    $v = [long]$Value
    if ($v -lt $Min -or $v -ge [long]::MaxValue) { throw [System.ArgumentException]::new("$Name is out of range") }
    $v
}

function New-RunReadContext {
    param([bool]$Bounded, [bool]$Reject, [long]$Total, [long]$Manifest, [long]$Marker, [long]$Entries, [long]$Depth)
    [pscustomobject]@{
        Bounded = $Bounded; Reject = $Reject; TotalLimit = $Total; ManifestLimit = $Manifest; MarkerLimit = $Marker
        MaxEntries = $Entries; MaxDepth = $Depth; Used = [long]0; EntryCount = [long]0
        Reads = @{ manifest = 0; complete = 0; records = 0; artifact = 0 }
    }
}

# Reads one open stream to its end through one 64 KiB buffer, counting what was actually read. With -HashOnly the bytes are hashed and not kept.
# Returns [pscustomobject]@{ Bytes; Sha256; Count }. Throws RUNBOUND:file_too_large or RUNBOUND:budget_exceeded when the limit is crossed.
function Read-RunStream {
    param([System.IO.Stream]$Stream, $Ctx, [long]$FileLimit, [switch]$HashOnly)
    $limited = [bool]$Ctx.Bounded
    $limit = [long]::MaxValue
    $code = 'file_too_large'
    if ($limited) {
        $remaining = [long]$Ctx.TotalLimit - [long]$Ctx.Used
        if ($remaining -lt $FileLimit) { $limit = $remaining; $code = 'budget_exceeded' } else { $limit = $FileLimit }
    }
    $buf = [byte[]]::new(65536)
    $count = [long]0
    $ms = if ($HashOnly) { $null } else { [System.IO.MemoryStream]::new() }
    $hasher = [System.Security.Cryptography.IncrementalHash]::CreateHash([System.Security.Cryptography.HashAlgorithmName]::SHA256)
    try {
        while ($true) {
            $ask = $buf.Length
            if ($limited) { $left = $limit - $count + 1; if ($left -lt $ask) { $ask = [int]$left } }
            $n = $Stream.Read($buf, 0, $ask)
            if ($n -le 0) { break }
            $count += $n
            if ($limited -and $count -gt $limit) { $Ctx.Used = [long]$Ctx.Used + $count; Stop-RunBound $code }
            $hasher.AppendData($buf, 0, $n)
            if ($null -ne $ms) { $ms.Write($buf, 0, $n) }
        }
        $Ctx.Used = [long]$Ctx.Used + $count
        $bytes = if ($null -ne $ms) { $ms.ToArray() } else { $null }
        [pscustomobject]@{ Bytes = $bytes; Sha256 = [Convert]::ToHexString($hasher.GetHashAndReset()).ToLowerInvariant(); Count = $count }
    } finally { $hasher.Dispose(); if ($null -ne $ms) { $ms.Dispose() } }
}

# Opens one file once (one handle, closed in finally) and reads it through Read-RunStream. Role names the counter of opens.
function Read-RunFile {
    param($Ctx, [string]$Path, [string]$Role, [long]$FileLimit = [long]::MaxValue, [switch]$HashOnly, [System.IO.FileShare]$Share = [System.IO.FileShare]::Read)
    $Ctx.Reads[$Role] = [int]$Ctx.Reads[$Role] + 1
    $fs = $null
    try {
        $fs = [System.IO.File]::Open($Path, [System.IO.FileMode]::Open, [System.IO.FileAccess]::Read, $Share)
        Read-RunStream -Stream $fs -Ctx $Ctx -FileLimit $FileLimit -HashOnly:$HashOnly
    } catch {
        if ($_.Exception.Message -like 'RUNBOUND:*') { throw }
        if ($Ctx.Bounded) { Stop-RunBound 'read_failed' }
        throw
    } finally { if ($null -ne $fs) { $fs.Dispose() } }
}

# Windows device names, alternate data streams and trailing dot or space in one relative path component. Only for the bounded mode.
function Test-RunPathComponent {
    param([string]$Component)
    if ($Component.Contains(':') -or $Component.EndsWith('.') -or $Component.EndsWith(' ')) { return $false }
    $stem = $Component.Split('.')[0].TrimEnd(' ')
    $stem -cnotmatch '^(?i:CON|PRN|AUX|NUL|CLOCK\$|COM[0-9\u00B9\u00B2\u00B3]|LPT[0-9\u00B9\u00B2\u00B3])$'
}

# $true: a regular file that is not a link. $false: nothing there (the caller reports it as missing, as before). Throws RUNBOUND for a link,
# a directory, or any other state in the bounded mode. Without -RejectReparsePoints this is Test-Path -PathType Leaf, as before.
function Test-RunLeaf {
    param($Ctx, [string]$Path)
    if (-not $Ctx.Reject) { return (Test-Path -LiteralPath $Path -PathType Leaf) }
    try { $a = [System.IO.File]::GetAttributes($Path) }
    catch [System.IO.FileNotFoundException], [System.IO.DirectoryNotFoundException] { return $false }
    catch { Stop-RunBound 'path_unsafe' }
    if (($a -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) { Stop-RunBound 'reparse_point' }
    if (($a -band [System.IO.FileAttributes]::Directory) -ne 0) { Stop-RunBound 'path_unsafe' }
    $true
}

# The root and every ancestor of it must not be a reparse point. A root that does not exist is left to the caller (no_manifest).
function Assert-RunRootPlain {
    param([string]$FullRoot)
    if ($FullRoot.StartsWith('\\.\') -or $FullRoot.StartsWith('\\?\')) { Stop-RunBound 'path_unsafe' }
    $cur = $FullRoot.TrimEnd('\', '/')
    if ($cur.Length -eq 2 -and $cur[1] -eq ':') { $cur += '\' }
    while ($true) {
        try { $a = [System.IO.File]::GetAttributes($cur) }
        catch [System.IO.FileNotFoundException], [System.IO.DirectoryNotFoundException] { return }
        catch { Stop-RunBound 'path_unsafe' }
        if (($a -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) { Stop-RunBound 'reparse_point' }
        $parent = [System.IO.Path]::GetDirectoryName($cur)
        if ([string]::IsNullOrEmpty($parent)) { return }
        $cur = $parent
    }
}

# The directories between the root and a relative file path must not be reparse points (an artifact below a junction).
function Assert-RunParentsPlain {
    param([string]$FullRoot, [string]$Rel)
    $parts = $Rel.Split('/')
    $cur = $FullRoot
    for ($i = 0; $i -lt $parts.Length - 1; $i++) {
        $cur = Join-Path $cur $parts[$i]
        try { $a = [System.IO.File]::GetAttributes($cur) }
        catch [System.IO.FileNotFoundException], [System.IO.DirectoryNotFoundException] { return }
        catch { Stop-RunBound 'path_unsafe' }
        if (($a -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) { Stop-RunBound 'reparse_point' }
    }
}

# Bounded enumeration of the files under a Run root: a depth-first walk over a stack of directories, with a lazy enumerator, so the walk
# stops at the first entry above the limit and never builds the whole list first. Root: depth 0; its direct children are level 0; a
# directory at level >= MaxDepth fails (the TypeScript walk reports such a directory as unlisted). Every entry (file or directory,
# valid or not) is counted when it is seen, before it is judged; a count equal to the limit passes and one more fails. A link is refused
# when -RejectReparsePoints is set; otherwise a directory link is not entered, as Get-ChildItem -Recurse does not enter it. Any error of
# the enumeration fails the verification.
function Get-RunFilesBounded {
    param($Ctx, [string]$FullRoot)
    $out = [System.Collections.Generic.List[string]]::new()
    if (-not (Test-Path -LiteralPath $FullRoot -PathType Container)) { return , $out }
    $opts = [System.IO.EnumerationOptions]::new()
    $opts.RecurseSubdirectories = $false; $opts.AttributesToSkip = [System.IO.FileAttributes]0; $opts.IgnoreInaccessible = $false; $opts.ReturnSpecialDirectories = $false
    $stack = [System.Collections.Generic.Stack[object]]::new()
    $stack.Push(@($FullRoot, '', 0))
    while ($stack.Count -gt 0) {
        $top = $stack.Pop()
        try {
            foreach ($e in ([System.IO.DirectoryInfo]::new([string]$top[0])).EnumerateFileSystemInfos('*', $opts)) {
                $Ctx.EntryCount = [long]$Ctx.EntryCount + 1
                if ($Ctx.EntryCount -gt $Ctx.MaxEntries) { Stop-RunBound 'entry_limit' }
                $isLink = (($e.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0)
                if ($isLink -and $Ctx.Reject) { Stop-RunBound 'reparse_point' }
                $rel = if ([string]$top[1] -eq '') { $e.Name } else { "$($top[1])/$($e.Name)" }
                if (($e.Attributes -band [System.IO.FileAttributes]::Directory) -ne 0) {
                    if ($isLink) { continue }
                    if ([long]$top[2] -ge [long]$Ctx.MaxDepth) { Stop-RunBound 'depth_limit' }
                    $stack.Push(@($e.FullName, $rel, ([long]$top[2] + 1)))
                } else { $out.Add($rel) }
            }
        } catch {
            if ($_.Exception.Message -like 'RUNBOUND:*') { throw }
            Stop-RunBound 'enumeration_failed'
        }
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

# Without -Bounded the behavior, the result, and the reasons are the existing ones: no limit, no link check. Bounded mode (all of the
# following need -Bounded; see the notes above Stop-RunBound):
#   -MaxTotalBytes, -MaxManifestBytes, -MaxMarkerBytes   raw bytes read (int or long; defaults 64 MiB, 4 MiB, 128 bytes)
#   -MaxEntries, -MaxDepth                               files and directories counted while walking (defaults 10000, 16)
#   -RejectReparsePoints                                 refuse links in the root, its ancestors, and everything under the root
#   -IncludeVerifiedData (with -RequireMarker)           adds the property VerifiedData: the verified manifest hash, the manifest parsed from
#                                                        the same bytes, and the records bytes that were hashed and walked; $null unless the
#                                                        result is success and COMPLETE equals the manifest hash. Nothing is printed.
# A bound that is crossed returns Incomplete = $true with IncompleteReason budget_exceeded, file_too_large, entry_limit, depth_limit,
# reparse_point, path_unsafe, read_failed, or enumeration_failed, ManifestSha256 = $null, and no Detail (no path, hash, or content).
function Test-RunDirectory {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)][string]$Path, [switch]$RequireMarker,
        [switch]$Bounded, $MaxTotalBytes, $MaxManifestBytes, $MaxMarkerBytes, $MaxEntries, $MaxDepth,
        [switch]$RejectReparsePoints, [switch]$IncludeVerifiedData
    )
    $limitGiven = $PSBoundParameters.ContainsKey('MaxTotalBytes') -or $PSBoundParameters.ContainsKey('MaxManifestBytes') -or $PSBoundParameters.ContainsKey('MaxMarkerBytes') -or $PSBoundParameters.ContainsKey('MaxEntries') -or $PSBoundParameters.ContainsKey('MaxDepth')
    if (-not $Bounded -and ($limitGiven -or $RejectReparsePoints -or $IncludeVerifiedData)) { throw [System.ArgumentException]::new('a limit, -RejectReparsePoints, and -IncludeVerifiedData need -Bounded') }
    if ($IncludeVerifiedData -and -not $RequireMarker) { throw [System.ArgumentException]::new('-IncludeVerifiedData needs -RequireMarker') }
    $d = $script:RunBoundDefaults
    $ctx = if ($Bounded) {
        New-RunReadContext -Bounded $true -Reject ([bool]$RejectReparsePoints) -Total (Resolve-RunBound $MaxTotalBytes 'MaxTotalBytes' $d.MaxTotalBytes) `
            -Manifest (Resolve-RunBound $MaxManifestBytes 'MaxManifestBytes' $d.MaxManifestBytes) -Marker (Resolve-RunBound $MaxMarkerBytes 'MaxMarkerBytes' $d.MaxMarkerBytes) `
            -Entries (Resolve-RunBound $MaxEntries 'MaxEntries' $d.MaxEntries) -Depth (Resolve-RunBound $MaxDepth 'MaxDepth' $d.MaxDepth -Min 0)
    } else { New-RunReadContext -Bounded $false -Reject $false -Total ([long]::MaxValue) -Manifest ([long]::MaxValue) -Marker ([long]::MaxValue) -Entries ([long]::MaxValue) -Depth ([long]::MaxValue) }
    $incomplete = {
        param($reason, $detail, $sha)
        $r = [pscustomobject]@{ Result = 'failure'; Incomplete = $true; IncompleteReason = $reason; Detail = $detail; Mismatches = @(); ManifestSha256 = $sha }
        if ($IncludeVerifiedData) { Add-Member -InputObject $r -NotePropertyName VerifiedData -NotePropertyValue $null }
        $r
    }
    try {
        if ($Bounded) {
            if ($Path.Contains([char]0)) { Stop-RunBound 'path_unsafe' }
            try { $Path = [System.IO.Path]::GetFullPath($Path) } catch { Stop-RunBound 'path_unsafe' }
            if ($RejectReparsePoints) { Assert-RunRootPlain -FullRoot $Path }
        }
        return (Invoke-RunDirectoryVerification -Path $Path -RequireMarker:$RequireMarker -Ctx $ctx -Incomplete $incomplete -IncludeVerifiedData:$IncludeVerifiedData)
    } catch {
        if ($_.Exception.Message -like 'RUNBOUND:*') { return (& $incomplete $_.Exception.Message.Substring(9) $null $null) }
        throw
    }
}

function Invoke-RunDirectoryVerification {
    param([string]$Path, [switch]$RequireMarker, $Ctx, [scriptblock]$Incomplete, [switch]$IncludeVerifiedData)
    $incomplete = $Incomplete
    $manifestPath = Join-Path $Path 'manifest.json'
    if (-not (Test-RunLeaf -Ctx $Ctx -Path $manifestPath)) { return (& $incomplete 'no_manifest' $null $null) }
    $manifestBytes = (Read-RunFile -Ctx $Ctx -Path $manifestPath -Role 'manifest' -FileLimit $Ctx.ManifestLimit).Bytes
    $manifestSha = Get-Sha256Hex -Bytes $manifestBytes
    $markerPath = Join-Path $Path 'COMPLETE'
    $markerText = $null
    if (Test-RunLeaf -Ctx $Ctx -Path $markerPath) {
        $markerBytes = (Read-RunFile -Ctx $Ctx -Path $markerPath -Role 'complete' -FileLimit $Ctx.MarkerLimit).Bytes
        # the decoding of File.ReadAllText: UTF-8, byte order mark honored
        $rd = [System.IO.StreamReader]::new([System.IO.MemoryStream]::new($markerBytes), [System.Text.Encoding]::UTF8, $true)
        try { $markerText = $rd.ReadToEnd() } finally { $rd.Dispose() }
    }
    if ($RequireMarker -and $null -eq $markerText) { return (& $incomplete 'no_completion_marker' $null $manifestSha) }

    $manifest = $null
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

    # In the bounded mode the walk comes first, so that a tree that is too large or too deep fails before any artifact is read.
    $present = $null
    if ($Ctx.Bounded) {
        foreach ($rel in $listed.Keys) { foreach ($c in $rel.Split('/')) { if (-not (Test-RunPathComponent -Component $c)) { Stop-RunBound 'path_unsafe' } } }
        $present = Get-RunFilesBounded -Ctx $Ctx -FullRoot $Path
    }
    # 2. the hash of every listed artifact. records.jsonl is read once: the bytes that are hashed here are the bytes of the chain walk (4).
    $recordsBytes = $null
    $recordsRead = $false
    foreach ($rel in $listed.Keys) {
        $full = Join-Path $Path $rel
        if ($Ctx.Reject) { Assert-RunParentsPlain -FullRoot $Path -Rel $rel }
        if (-not (Test-RunLeaf -Ctx $Ctx -Path $full)) { & $flag $rel 'missing'; continue }
        if ($rel -ieq 'records.jsonl') {
            $rr = Read-RunFile -Ctx $Ctx -Path $full -Role 'records' -Share ([System.IO.FileShare]::ReadWrite)
            $recordsBytes = $rr.Bytes; $recordsRead = $true; $h = $rr.Sha256
        } else {
            $h = (Read-RunFile -Ctx $Ctx -Path $full -Role 'artifact' -HashOnly -Share ([System.IO.FileShare]::ReadWrite)).Sha256
        }
        if ($h -cne $listed[$rel]) { & $flag $rel 'modified' }
        elseif ($rel.StartsWith('blobs/') -and $rel -cne "blobs/$($listed[$rel])") { & $flag $rel 'modified' }
    }
    # 3. files present but not listed
    if ($null -eq $present) { $present = Get-RelativeFiles -Root $Path }
    foreach ($rel in $present) {
        if ($listed.ContainsKey($rel)) { continue }
        if (-not $rel.Contains('/') -and ($script:UnlistedOk -contains $rel)) { continue }
        & $flag $rel 'unlisted'
    }
    # 4. the hash chain
    $blobRefs = [System.Collections.Generic.HashSet[string]]::new()
    $count = 0
    $lastStored = $script:GenesisHash
    $recordsPath = Join-Path $Path 'records.jsonl'
    if ($recordsRead -or (Test-RunLeaf -Ctx $Ctx -Path $recordsPath)) {
        if (-not $recordsRead) {
            if ($Ctx.Reject) { Assert-RunParentsPlain -FullRoot $Path -Rel 'records.jsonl' }
            $recordsBytes = (Read-RunFile -Ctx $Ctx -Path $recordsPath -Role 'records' -Share ([System.IO.FileShare]::ReadWrite)).Bytes
        }
        $text = $script:Utf8.GetString($recordsBytes)
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
    $result = [pscustomobject]@{
        Result = $(if ($mismatches.Count -eq 0) { 'success' } else { 'failure' })
        Incomplete = $false; IncompleteReason = $null; Detail = $null; Mismatches = $mismatches; ManifestSha256 = $manifestSha
    }
    if ($IncludeVerifiedData) {
        # The data that the caller may use without reading the Run again. Only for a success whose COMPLETE equals the hash of the manifest
        # bytes that were parsed; everything else gets $null (never data of a failed or half-verified Run). Same decision as Test-CompletedRun.
        $verified = $null
        if ($result.Result -ceq 'success' -and ($markerText -replace '\r?\n$', '') -ceq $manifestSha) {
            $verified = [pscustomobject]@{
                ManifestSha256 = $manifestSha; Manifest = $manifest; MarkerMatchesManifest = $true; RecordsBytes = $recordsBytes
                ReadCounts = [pscustomobject]@{ manifest = [int]$Ctx.Reads['manifest']; complete = [int]$Ctx.Reads['complete']; records = [int]$Ctx.Reads['records']; artifact = [int]$Ctx.Reads['artifact'] }
                BytesRead = [long]$Ctx.Used; EntryCount = [long]$Ctx.EntryCount
            }
        }
        Add-Member -InputObject $result -NotePropertyName VerifiedData -NotePropertyValue $verified
    }
    $result
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