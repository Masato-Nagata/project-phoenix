#Requires -Version 7.0
# External anchor of the Approval_Store, READ side only (task 4.10, step B2; R23.14; design "External anchor for the Approval_Store").
#
# An anchor is a small file that a HUMAN keeps outside the repository: {"seq":N,"hash":"<64 lower-case hex>"}. It records the sequence
# number and the hash of one stored line. This module only reads and validates it. No function here creates, changes or deletes an
# anchor or any other file (a static test checks the source for write APIs). Writing the anchor is the human's job.
#
# What the checks give, and what they do not:
#   - The path must be an absolute, normalised drive path outside the repository, with no reparse point (junction or symbolic link)
#     in any component, and must name a regular file. "Outside the repository" says where the file is. It says nothing about who can
#     write it or whether its content is trustworthy; the access rights of the storage are the human's responsibility.
#   - The path is checked first and the file is opened afterwards. A component swapped for a link between the two steps is NOT
#     prevented. A hard link, a mapped or substituted drive, and an alias of the repository that the string comparison cannot see are
#     not detected either. A wrong file read this way is still only accepted if it has the exact two-key format, and it only passes
#     the store comparison if its hash equals the hash of the stored line.
#   - At most 4096 bytes are read. The size is checked before the read and the read itself stops at 4097 bytes, so a file that grows
#     after the size check cannot make the reader take more than 4097 bytes.
#   - Every failure is reported as one fixed code. The path, the content, the hash and the text of an exception are never returned.
Set-StrictMode -Version Latest
Import-Module (Join-Path $PSScriptRoot 'DiscoveryCommon.psm1') -DisableNameChecking

$script:MaxAnchorBytes = 4096
$script:MaxSafeInteger = 9007199254740991
$script:Utf8Strict = [System.Text.UTF8Encoding]::new($false, $true)
$script:RepoRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../..'))
$script:AnchorCodes = @('anchor_path_invalid', 'anchor_path_in_repository', 'anchor_path_reparse_point', 'anchor_not_found', 'anchor_not_regular_file', 'anchor_unreadable', 'anchor_too_large', 'anchor_malformed')

function Get-ApprovalAnchorCodes { , @($script:AnchorCodes) }
function Get-ApprovalAnchorMaxBytes { $script:MaxAnchorBytes }

function New-AnchorFailure {
    param([string]$Code)
    [pscustomobject]@{ Ok = $false; Code = $Code; Anchor = $null }
}

# The strict shape of a parsed anchor: exactly the keys `seq` and `hash` (case-sensitive), seq a JSON integer from 1 to 2^53-1 (no
# string, boolean, fraction or exponent form is converted), hash a string of exactly 64 lower-case hex characters.
function Test-ApprovalAnchorDictionary {
    param($Value)
    if ($Value -isnot [System.Collections.IDictionary]) { return $false }
    $names = @($Value.Keys | ForEach-Object { [string]$_ })
    if ($names.Count -ne 2 -or $names -cnotcontains 'seq' -or $names -cnotcontains 'hash') { return $false }
    $s = $Value['seq']
    if ($s -isnot [long] -or $s -lt 1 -or $s -gt $script:MaxSafeInteger) { return $false }
    $h = $Value['hash']
    if ($h -isnot [string] -or $h -cnotmatch '\A[0-9a-f]{64}\z') { return $false }
    $true
}

# Bytes of the anchor file -> { Ok, Code, Anchor }. Never throws.
function ConvertFrom-ApprovalAnchorBytes {
    [CmdletBinding()]
    param([Parameter(Mandatory)][AllowEmptyCollection()][byte[]]$Bytes)
    try {
        if ($Bytes.Length -gt $script:MaxAnchorBytes) { return (New-AnchorFailure 'anchor_too_large') }
        $text = $script:Utf8Strict.GetString($Bytes)
        $parsed = ConvertFrom-JsonStrict -Text $text
        if (-not (Test-ApprovalAnchorDictionary $parsed)) { return (New-AnchorFailure 'anchor_malformed') }
        [pscustomobject]@{ Ok = $true; Code = $null; Anchor = [pscustomobject]@{ seq = [long]$parsed['seq']; hash = [string]$parsed['hash'] } }
    } catch { New-AnchorFailure 'anchor_malformed' }
}

# Checks the path text and the path components. Returns { Ok, Code, FullPath }. Opens nothing for reading content.
function Test-ApprovalAnchorPath {
    [CmdletBinding()]
    param($Path)
    $fail = { param($code) [pscustomobject]@{ Ok = $false; Code = $code; FullPath = $null } }
    try {
        if ($Path -isnot [string] -or $Path.Length -lt 4 -or $Path.Length -gt 1024) { return (& $fail 'anchor_path_invalid') }
        if ($Path -cnotmatch '\A[A-Za-z]:\\') { return (& $fail 'anchor_path_invalid') }   # drive-absolute only: no relative, UNC, \\?\ or \\.\ form
        if ($Path.IndexOf(':', 2) -ge 0) { return (& $fail 'anchor_path_invalid') }        # no alternate data stream
        foreach ($ch in $Path.ToCharArray()) { if ([int]$ch -lt 32 -or '"<>|*?'.Contains($ch)) { return (& $fail 'anchor_path_invalid') } }
        $full = [System.IO.Path]::GetFullPath($Path)
        if ($full -cne $Path) { return (& $fail 'anchor_path_invalid') }                   # not normalised: '/', '..', '.', '\\', trailing dot, 8.3 name
        $segments = $full.Substring(3).Split('\')
        for ($i = 0; $i -lt $segments.Count; $i++) {
            if ($segments[$i] -eq '') { return (& $fail 'anchor_path_invalid') }           # also a trailing separator: a directory, not a file
            if ($segments[$i] -imatch '\A(CON|PRN|AUX|NUL|COM[0-9]|LPT[0-9])(\..*)?\z') { return (& $fail 'anchor_path_invalid') }
        }
        $repo = $script:RepoRoot.TrimEnd('\')
        if ($full.Equals($repo, [System.StringComparison]::OrdinalIgnoreCase) -or $full.StartsWith($repo + '\', [System.StringComparison]::OrdinalIgnoreCase)) {
            return (& $fail 'anchor_path_in_repository')
        }
        $current = $full.Substring(0, 3)
        for ($i = 0; $i -lt $segments.Count; $i++) {
            $current = Join-Path $current $segments[$i]
            $isLast = ($i -eq $segments.Count - 1)
            try { $attr = [System.IO.File]::GetAttributes($current) }
            catch [System.IO.FileNotFoundException], [System.IO.DirectoryNotFoundException] { return (& $fail 'anchor_not_found') }
            catch { return (& $fail 'anchor_unreadable') }
            if (($attr -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) { return (& $fail 'anchor_path_reparse_point') }
            $isDir = (($attr -band [System.IO.FileAttributes]::Directory) -ne 0)
            if ($isLast -and ($isDir -or (($attr -band [System.IO.FileAttributes]::Device) -ne 0))) { return (& $fail 'anchor_not_regular_file') }
            if (-not $isLast -and -not $isDir) { return (& $fail 'anchor_not_found') }
        }
        [pscustomobject]@{ Ok = $true; Code = $null; FullPath = $full }
    } catch { & $fail 'anchor_path_invalid' }
}

# Path of the anchor file -> { Ok, Code, Anchor }. Never throws and never falls back: a caller that was given an anchor path and gets
# Ok = $false must refuse the operation. Opens the file for reading only, with FileShare.Read so that nobody writes it during the read.
function Read-ApprovalAnchor {
    [CmdletBinding()]
    param([Parameter(Mandatory)][AllowNull()][AllowEmptyString()]$Path)
    try {
        $check = Test-ApprovalAnchorPath -Path $Path
        if (-not $check.Ok) { return (New-AnchorFailure $check.Code) }
        $fs = $null
        try { $fs = [System.IO.FileStream]::new($check.FullPath, [System.IO.FileMode]::Open, [System.IO.FileAccess]::Read, [System.IO.FileShare]::Read, 1, [System.IO.FileOptions]::None) }
        catch [System.IO.FileNotFoundException], [System.IO.DirectoryNotFoundException] { return (New-AnchorFailure 'anchor_not_found') }
        catch [System.NotSupportedException] { return (New-AnchorFailure 'anchor_not_regular_file') }
        catch { return (New-AnchorFailure 'anchor_unreadable') }
        try {
            if (-not $fs.CanSeek) { return (New-AnchorFailure 'anchor_not_regular_file') }
            if ($fs.Length -gt $script:MaxAnchorBytes) { return (New-AnchorFailure 'anchor_too_large') }
            $limit = $script:MaxAnchorBytes + 1
            $buffer = [byte[]]::new($limit)
            $total = 0
            while ($total -lt $limit) {
                $n = $fs.Read($buffer, $total, $limit - $total)
                if ($n -le 0) { break }
                $total += $n
            }
            if ($total -gt $script:MaxAnchorBytes) { return (New-AnchorFailure 'anchor_too_large') }
            $content = [byte[]]::new($total)
            [System.Array]::Copy($buffer, $content, $total)
        } catch { return (New-AnchorFailure 'anchor_unreadable') }
        finally { $fs.Dispose() }
        ConvertFrom-ApprovalAnchorBytes -Bytes $content
    } catch { New-AnchorFailure 'anchor_unreadable' }
}

Export-ModuleMember -Function Get-ApprovalAnchorCodes, Get-ApprovalAnchorMaxBytes, Test-ApprovalAnchorDictionary, ConvertFrom-ApprovalAnchorBytes, Test-ApprovalAnchorPath, Read-ApprovalAnchor
