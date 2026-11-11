# Reference implementation of the AI input rule (R9.2, docs/ai-input-allowlist.md).
# It is a test harness, not the analyzer: the analyzer is not implemented yet. It shows the rule the
# analyzer must follow and lets the tests check that the rule keeps every non-allowlisted file out.
#
# Rule: the input is exactly the concrete files listed in the allowlist JSON. No directory listing,
# no recursion, no wildcard expansion. Any entry that is not a plain relative path to an existing regular
# file under legacy/src or legacy/sql, or that passes through a reparse point (junction or symbolic
# link), aborts the whole build (fail closed). There is no partial result.

function Assert-AiInputEntry {
    param([Parameter(Mandatory)][string]$Root, [Parameter(Mandatory)][string]$Entry)
    if ($Entry -ne $Entry.Trim() -or $Entry.Length -eq 0) { throw "allowlist entry has surrounding whitespace or is empty: '$Entry'" }
    if ($Entry.Contains('\')) { throw "allowlist entry uses a backslash: '$Entry'" }
    if ($Entry -match '[*?\[\]{}]') { throw "allowlist entry contains a wildcard: '$Entry'" }
    if ($Entry.StartsWith('/') -or $Entry -match '^[A-Za-z]:' -or $Entry.StartsWith('~')) { throw "allowlist entry is absolute: '$Entry'" }
    $segments = $Entry.Split('/')
    if ($segments | Where-Object { $_ -in '', '.', '..' }) { throw "allowlist entry has an empty, '.' or '..' segment: '$Entry'" }
    if ($Entry -notmatch '^legacy/(src/[^/]+\.php|sql/[^/]+\.sql)$') { throw "allowlist entry is not a .php file directly under legacy/src or a .sql file directly under legacy/sql: '$Entry'" }
    $rootFull = [IO.Path]::GetFullPath($Root)
    $full = [IO.Path]::GetFullPath((Join-Path $rootFull $Entry))
    if (-not $full.StartsWith($rootFull.TrimEnd('\', '/') + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) { throw "allowlist entry resolves outside the root: '$Entry'" }
    # Every component from the root down to the file must exist and must not be a reparse point.
    $cur = $rootFull
    foreach ($s in $segments) {
        $cur = Join-Path $cur $s
        $item = Get-Item -LiteralPath $cur -Force -ErrorAction SilentlyContinue
        if (-not $item) { throw "allowlist entry does not exist: '$Entry'" }
        if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw "allowlist entry passes through a link or junction: '$Entry'" }
    }
    $leaf = Get-Item -LiteralPath $full -Force
    if ($leaf.PSIsContainer) { throw "allowlist entry is a directory: '$Entry'" }
    $full
}

function New-AiInputBundle {
    param([Parameter(Mandatory)][string]$Root, [Parameter(Mandatory)][string]$AllowlistPath)
    $allow = Get-Content -Raw -LiteralPath $AllowlistPath | ConvertFrom-Json -Depth 10
    $entries = @($allow.files)
    if ($entries.Count -eq 0) { throw 'allowlist is empty' }
    if (@($entries | Sort-Object -Unique).Count -ne $entries.Count) { throw 'allowlist has duplicate entries' }
    $manifest = New-Object System.Collections.Generic.List[object]
    $sb = New-Object Text.StringBuilder
    foreach ($e in $entries) {
        $full = Assert-AiInputEntry -Root $Root -Entry ([string]$e)
        $text = [IO.File]::ReadAllText($full).Replace("`r`n", "`n")
        $hash = ([BitConverter]::ToString([Security.Cryptography.SHA256]::Create().ComputeHash([Text.Encoding]::UTF8.GetBytes($text)))).Replace('-', '').ToLowerInvariant()
        $manifest.Add([pscustomobject]@{ path = [string]$e; sha256_lf = $hash; chars = $text.Length })
        [void]$sb.Append("=== FILE: $e ===`n").Append($text).Append("`n")
    }
    [pscustomobject]@{ Manifest = $manifest.ToArray(); Payload = $sb.ToString() }
}