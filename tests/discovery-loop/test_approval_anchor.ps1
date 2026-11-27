#Requires -Version 7.0
# Tests of the external anchor of the Approval_Store (task 4.10, step B2; R23.14): the strict anchor format, the path rules, the
# anchored verification and append, the protection scope that is reported, the pre-write comparison of the store, and the static
# checks. Everything uses synthetic stores and synthetic anchors in temporary directories outside the repository. The real
# approval directory of the repository and any real anchor are never read, written or named, and no real Approval_Record is created.
# In-process tests use a test-specific store mutex name. The tests write anchors; the product code does not.
. (Join-Path $PSScriptRoot 'lib/testlib.ps1')
Import-Module (Join-Path $script:ToolsDir 'DiscoveryCommon.psm1') -Force -DisableNameChecking
Import-Module (Join-Path $script:ToolsDir 'ApprovalAnchor.psm1') -Force -DisableNameChecking
Import-Module (Join-Path $script:ToolsDir 'ApprovalStore.psm1') -Force -DisableNameChecking

$utf8 = [System.Text.UTF8Encoding]::new($false)
$mutexName = 'Local\PhoenixTest-ApprovalAnchor-' + [guid]::NewGuid().ToString('N')
$addCommand = Join-Path $script:ToolsDir 'Add-ApprovalRecord.ps1'
$H64 = 'ab' * 32

function New-Candidate {
    param([int]$I = 1, $Target = ([ordered]@{ kind = 'gate'; gate_id = 'container-runtime' }))
    [ordered]@{ approver = 'Test Approver'; timestamp = '2025-03-04T05:06:07.000+09:00'; target = $Target; decision = 'approved'; rationale = "Record $I."; recorded_by = 'human' }
}
function Invoke-Req { param([string]$Store, $Request, [scriptblock]$Resolver, [string]$AnchorPath, [switch]$UseAnchor)
    if ($UseAnchor) { Invoke-ApprovalStoreRequest -StorePath $Store -Request $Request -MutexName $mutexName -TargetResolver $Resolver -AnchorPath $AnchorPath }
    else { Invoke-ApprovalStoreRequest -StorePath $Store -Request $Request -MutexName $mutexName -TargetResolver $Resolver }
}
function New-TestStore {
    param([string]$Dir, [int]$Count, [string]$Name = 'approvals.jsonl')
    $p = Join-Path $Dir $Name
    [IO.File]::WriteAllBytes($p, [byte[]]@())
    for ($i = 1; $i -le $Count; $i++) { [void](Invoke-Req $p ([ordered]@{ operation = 'append'; candidate = (New-Candidate $i) })) }
    $p
}
function Get-Lines { param([string]$Path) @([IO.File]::ReadAllText($Path, $utf8).Split("`n") | Where-Object { $_ -ne '' }) }
function Get-HashAt { param([string]$Store, [int]$Seq) $l = @(Get-Lines $Store); (ConvertFrom-JsonStrict -Text $l[$Seq - 1])['hash'] }
function Write-AnchorFile { param([string]$Path, $Seq, [string]$Hash) [IO.File]::WriteAllText($Path, "{`"seq`":$Seq,`"hash`":`"$Hash`"}", $utf8) }
# Rewrites a store from line objects with prev_hash and hash recomputed (an attacker who edits and re-chains).
function Write-RechainedStore {
    param([string]$Path, $Lines)
    $prev = '0' * 64; $text = ''
    foreach ($l in $Lines) {
        $o = [ordered]@{}; foreach ($k in $l.Keys) { $o[$k] = $l[$k] }
        $o['prev_hash'] = $prev; $o['hash'] = Get-StoredLineHash -Line $o
        $text += ConvertTo-StoredLineText -Line $o; $prev = $o['hash']
    }
    [IO.File]::WriteAllText($Path, $text, $utf8)
}
function Read-LineObjects { param([string]$Path) @(Get-Lines $Path | ForEach-Object { ConvertFrom-JsonStrict -Text $_ }) }
function Get-Mismatches { param($R) (@($R.Mismatches | ForEach-Object { "$($_.Seq):$($_.Kind)" }) -join ',') }
function Get-Stamp { param([string]$Path) $i = Get-Item -LiteralPath $Path; "$($i.Length)|$($i.LastWriteTimeUtc.Ticks)" }
function Test-NoLeak { param([string]$Text, [string[]]$Secrets) foreach ($s in $Secrets) { if ($s -and $Text.Contains($s)) { return $false } }; $true }

Invoke-TestMain {
    Write-Host '=== Approval_Store external anchor (task 4.10, B2) ===' -ForegroundColor Cyan
    $root = [IO.Path]::GetFullPath((New-TempDir))
    Test-Case 'precondition: the temporary directory is a normalised drive path outside the repository' ($root -cmatch '\A[A-Za-z]:\\' -and -not $root.Contains('~') -and -not $root.StartsWith($script:RepoRoot, [StringComparison]::OrdinalIgnoreCase))

    # ---------------------------------------------------------------------------------------------------------------
    # 1. Anchor format (strict)
    $fdir = Join-Path $root 'format'; [void][IO.Directory]::CreateDirectory($fdir)
    $okCases = @(
        @{ Name = 'compact canonical form'; Text = "{`"seq`":3,`"hash`":`"$H64`"}"; Seq = 3 },
        @{ Name = 'one trailing LF'; Text = "{`"seq`":3,`"hash`":`"$H64`"}`n"; Seq = 3 },
        @{ Name = 'CRLF and indentation (JSON white space)'; Text = "{`r`n  `"seq`": 3,`r`n  `"hash`": `"$H64`"`r`n}`r`n"; Seq = 3 },
        @{ Name = 'the key order is not significant'; Text = "{`"hash`":`"$H64`",`"seq`":3}"; Seq = 3 },
        @{ Name = 'the largest safe integer as seq'; Text = "{`"seq`":9007199254740991,`"hash`":`"$H64`"}"; Seq = 9007199254740991 },
        @{ Name = 'exactly 4096 bytes (padded with spaces)'; Text = ("{`"seq`":3,`"hash`":`"$H64`"}" + (' ' * (4096 - 83))); Seq = 3 }
    )
    $n = 0
    foreach ($c in $okCases) {
        $n++; $p = Join-Path $fdir "ok$n.json"; [IO.File]::WriteAllBytes($p, $utf8.GetBytes($c.Text))
        $r = Read-ApprovalAnchor -Path $p
        Test-Case "anchor format accepted: $($c.Name)" ($r.Ok -and $null -eq $r.Code -and $r.Anchor.seq -is [long] -and $r.Anchor.seq -eq $c.Seq -and $r.Anchor.hash -ceq $H64) "code=$($r.Code)"
    }
    $badText = @(
        @{ Name = 'missing seq'; Text = "{`"hash`":`"$H64`"}" },
        @{ Name = 'missing hash'; Text = '{"seq":1}' },
        @{ Name = 'empty object'; Text = '{}' },
        @{ Name = 'unknown key'; Text = "{`"seq`":1,`"hash`":`"$H64`",`"extra`":1}" },
        @{ Name = 'key Seq instead of seq (case-sensitive)'; Text = "{`"Seq`":1,`"hash`":`"$H64`"}" },
        @{ Name = 'key HASH instead of hash'; Text = "{`"seq`":1,`"HASH`":`"$H64`"}" },
        @{ Name = 'duplicate key seq'; Text = "{`"seq`":1,`"seq`":2,`"hash`":`"$H64`"}" },
        @{ Name = 'duplicate key hash'; Text = "{`"seq`":1,`"hash`":`"$H64`",`"hash`":`"$H64`"}" },
        @{ Name = 'duplicate key that differs only in case'; Text = "{`"seq`":1,`"SEQ`":2,`"hash`":`"$H64`"}" },
        @{ Name = 'text that is not JSON'; Text = 'not json' },
        @{ Name = 'truncated JSON'; Text = '{"seq":1,' },
        @{ Name = 'empty file'; Text = '' },
        @{ Name = 'white space only'; Text = ' ' },
        @{ Name = 'root null'; Text = 'null' },
        @{ Name = 'root array'; Text = "[1,`"$H64`"]" },
        @{ Name = 'root string'; Text = "`"$H64`"" },
        @{ Name = 'root number'; Text = '1' },
        @{ Name = 'root true'; Text = 'true' },
        @{ Name = 'seq as a string'; Text = "{`"seq`":`"1`",`"hash`":`"$H64`"}" },
        @{ Name = 'seq 1.0'; Text = "{`"seq`":1.0,`"hash`":`"$H64`"}" },
        @{ Name = 'seq 1.5'; Text = "{`"seq`":1.5,`"hash`":`"$H64`"}" },
        @{ Name = 'seq in exponent form'; Text = "{`"seq`":1e0,`"hash`":`"$H64`"}" },
        @{ Name = 'seq true'; Text = "{`"seq`":true,`"hash`":`"$H64`"}" },
        @{ Name = 'seq null'; Text = "{`"seq`":null,`"hash`":`"$H64`"}" },
        @{ Name = 'seq 0'; Text = "{`"seq`":0,`"hash`":`"$H64`"}" },
        @{ Name = 'seq -1'; Text = "{`"seq`":-1,`"hash`":`"$H64`"}" },
        @{ Name = 'seq above the safe integer range'; Text = "{`"seq`":9007199254740992,`"hash`":`"$H64`"}" },
        @{ Name = 'seq above the 64-bit range'; Text = "{`"seq`":9223372036854775808,`"hash`":`"$H64`"}" },
        @{ Name = 'seq with a leading zero'; Text = "{`"seq`":01,`"hash`":`"$H64`"}" },
        @{ Name = 'seq as an array'; Text = "{`"seq`":[1],`"hash`":`"$H64`"}" },
        @{ Name = 'seq as an object'; Text = "{`"seq`":{},`"hash`":`"$H64`"}" },
        @{ Name = 'hash in upper case'; Text = "{`"seq`":1,`"hash`":`"$($H64.ToUpperInvariant())`"}" },
        @{ Name = 'hash of 63 characters'; Text = "{`"seq`":1,`"hash`":`"$($H64.Substring(1))`"}" },
        @{ Name = 'hash of 65 characters'; Text = "{`"seq`":1,`"hash`":`"${H64}a`"}" },
        @{ Name = 'hash with a trailing line feed (a regex $ would accept it)'; Text = "{`"seq`":1,`"hash`":`"$H64\n`"}" },
        @{ Name = 'hash padded with spaces'; Text = "{`"seq`":1,`"hash`":`" $($H64.Substring(2)) `"}" },
        @{ Name = 'hash as a number'; Text = '{"seq":1,"hash":1}' },
        @{ Name = 'hash null'; Text = '{"seq":1,"hash":null}' },
        @{ Name = 'hash as an array'; Text = "{`"seq`":1,`"hash`":[`"$H64`"]}" },
        @{ Name = 'hash with 64 non-hex characters'; Text = "{`"seq`":1,`"hash`":`"$('g' * 64)`"}" },
        @{ Name = 'hash with 64 full-width digits'; Text = "{`"seq`":1,`"hash`":`"$([string]::new([char]0xFF10, 64))`"}" },
        @{ Name = 'garbage after the object'; Text = "{`"seq`":1,`"hash`":`"$H64`"}x" },
        @{ Name = 'a trailing comma'; Text = "{`"seq`":1,`"hash`":`"$H64`",}" },
        @{ Name = 'a comment'; Text = "{`"seq`":1,/*c*/`"hash`":`"$H64`"}" },
        @{ Name = 'two objects'; Text = "{`"seq`":1,`"hash`":`"$H64`"}{`"seq`":1,`"hash`":`"$H64`"}" }
    )
    foreach ($c in $badText) {
        $n++; $p = Join-Path $fdir "bad$n.json"; [IO.File]::WriteAllBytes($p, $utf8.GetBytes($c.Text))
        $r = Read-ApprovalAnchor -Path $p
        Test-Case "anchor format refused (anchor_malformed): $($c.Name)" (-not $r.Ok -and $r.Code -ceq 'anchor_malformed' -and $null -eq $r.Anchor) "ok=$($r.Ok) code=$($r.Code)"
    }
    $okBytes = $utf8.GetBytes("{`"seq`":1,`"hash`":`"$H64`"}")
    $badBytes = @(
        @{ Name = 'a UTF-8 byte order mark'; Bytes = ([byte[]](0xEF, 0xBB, 0xBF) + $okBytes) },
        @{ Name = 'an invalid UTF-8 byte inside the text'; Bytes = ($utf8.GetBytes('{"seq":1,"hash":"') + [byte[]](0xFF) + $utf8.GetBytes("$($H64.Substring(1))`"}")) },
        @{ Name = 'a NUL byte'; Bytes = ($okBytes + [byte[]](0)) },
        @{ Name = 'UTF-16 encoded text'; Bytes = [System.Text.Encoding]::Unicode.GetBytes("{`"seq`":1,`"hash`":`"$H64`"}") }
    )
    foreach ($c in $badBytes) {
        $n++; $p = Join-Path $fdir "badb$n.json"; [IO.File]::WriteAllBytes($p, [byte[]]$c.Bytes)
        $r = Read-ApprovalAnchor -Path $p
        Test-Case "anchor format refused (anchor_malformed): $($c.Name)" (-not $r.Ok -and $r.Code -ceq 'anchor_malformed') "code=$($r.Code)"
    }

    # size limit
    $p = Join-Path $fdir 'size4097.json'; [IO.File]::WriteAllBytes($p, $utf8.GetBytes("{`"seq`":3,`"hash`":`"$H64`"}" + (' ' * (4097 - 83))))
    $r = Read-ApprovalAnchor -Path $p
    Test-Case 'size limit: 4097 bytes is refused with anchor_too_large' (-not $r.Ok -and $r.Code -ceq 'anchor_too_large') "code=$($r.Code)"
    $p = Join-Path $fdir 'size5m.json'; [IO.File]::WriteAllBytes($p, [byte[]]::new(5MB))
    $r = Read-ApprovalAnchor -Path $p
    Test-Case 'size limit: a 5 MiB file is refused with anchor_too_large, not as a format error' (-not $r.Ok -and $r.Code -ceq 'anchor_too_large') "code=$($r.Code)"
    $r = ConvertFrom-ApprovalAnchorBytes -Bytes ([byte[]]::new(4097))
    Test-Case 'size limit: the byte parser refuses 4097 bytes by itself' (-not $r.Ok -and $r.Code -ceq 'anchor_too_large')
    Test-Case 'size limit: the documented maximum is 4096 bytes' ((Get-ApprovalAnchorMaxBytes) -eq 4096)

    # ---------------------------------------------------------------------------------------------------------------
    # 2. Anchor path
    $pdir = Join-Path $root 'paths'; [void][IO.Directory]::CreateDirectory($pdir)
    $good = Join-Path $pdir 'anchor.json'; Write-AnchorFile $good 2 $H64
    $r = Read-ApprovalAnchor -Path $good
    Test-Case 'path: an absolute normalised file outside the repository is read' ($r.Ok -and $r.Anchor.seq -eq 2)
    $pathCases = @(
        @{ Name = 'empty string'; Path = '' },
        @{ Name = 'null'; Path = $null },
        @{ Name = 'a number'; Path = 12345 },
        @{ Name = 'relative file name'; Path = 'anchor.json' },
        @{ Name = 'relative with dot'; Path = '.\anchor.json' },
        @{ Name = 'drive-relative form'; Path = 'C:anchor.json' },
        @{ Name = 'UNC path'; Path = '\\server\share\anchor.json' },
        @{ Name = 'extended-length prefix'; Path = ('\\?\' + $good) },
        @{ Name = 'device prefix'; Path = ('\\.\' + $good) },
        @{ Name = 'forward slashes'; Path = $good.Replace('\', '/') },
        @{ Name = 'dot-dot segment'; Path = (Join-Path $pdir 'sub\..\anchor.json') },
        @{ Name = 'dot segment'; Path = (Join-Path $pdir '.\anchor.json') },
        @{ Name = 'doubled separator'; Path = ($pdir + '\\anchor.json') },
        @{ Name = 'trailing dot'; Path = ($good + '.') },
        @{ Name = 'alternate data stream'; Path = ($good + ':stream') },
        @{ Name = 'wildcard'; Path = (Join-Path $pdir 'anch*.json') },
        @{ Name = 'question mark'; Path = (Join-Path $pdir 'anchor?.json') },
        @{ Name = 'control character'; Path = (Join-Path $pdir "anc`thor.json") },
        @{ Name = 'longer than 1024 characters'; Path = ('C:\' + ('a' * 1100)) },
        @{ Name = 'reserved device name NUL'; Path = (Join-Path $pdir 'nul') },
        @{ Name = 'reserved device name with extension'; Path = (Join-Path $pdir 'CON.json') },
        @{ Name = 'trailing separator'; Path = ($pdir + '\') },
        @{ Name = 'a drive root'; Path = 'C:\' }
    )
    foreach ($c in $pathCases) {
        $r = Read-ApprovalAnchor -Path $c.Path
        Test-Case "path refused (anchor_path_invalid): $($c.Name)" (-not $r.Ok -and $r.Code -ceq 'anchor_path_invalid') "code=$($r.Code)"
    }
    $short = $good
    try { $short = (New-Object -ComObject Scripting.FileSystemObject).GetFile($good).ShortPath } catch { }
    if ($short -cne $good) {
        $r = Read-ApprovalAnchor -Path $short
        Test-Case 'path refused (anchor_path_invalid): the 8.3 short name of an existing anchor' (-not $r.Ok -and $r.Code -ceq 'anchor_path_invalid') "code=$($r.Code)"
    } else { Write-Host 'NOT MEASURED: 8.3 short names are not available on this volume' -ForegroundColor Yellow }

    # repository
    $repo = $script:RepoRoot.TrimEnd('\')
    $inRepo = @(
        @{ Name = 'an existing file at the repository root'; Path = (Join-Path $repo 'package.json') },
        @{ Name = 'the repository root itself'; Path = $repo },
        @{ Name = 'a file that does not exist under the repository'; Path = (Join-Path $repo 'tests\discovery-loop\no-such-anchor.json') },
        @{ Name = 'upper-case spelling of the repository path'; Path = ($repo.ToUpperInvariant() + '\PACKAGE.JSON') },
        @{ Name = 'lower-case spelling of the repository path'; Path = ($repo.ToLowerInvariant() + '\package.json') }
    )
    foreach ($c in $inRepo) {
        $r = Read-ApprovalAnchor -Path $c.Path
        Test-Case "path refused (anchor_path_in_repository): $($c.Name)" (-not $r.Ok -and $r.Code -ceq 'anchor_path_in_repository') "code=$($r.Code)"
    }
    $r = Read-ApprovalAnchor -Path ($repo + 'X\anchor.json')
    Test-Case 'path: a sibling directory whose name only starts like the repository is not "inside" (it is just absent)' (-not $r.Ok -and $r.Code -ceq 'anchor_not_found') "code=$($r.Code)"
    $r = Read-ApprovalAnchor -Path ($repo + '\tests\..\package.json')
    Test-Case 'path: a dot-dot route into the repository is refused as a non-normalised path' (-not $r.Ok -and $r.Code -ceq 'anchor_path_invalid') "code=$($r.Code)"

    # existence and kind
    $r = Read-ApprovalAnchor -Path (Join-Path $pdir 'absent.json')
    Test-Case 'path: a file that does not exist gives anchor_not_found' (-not $r.Ok -and $r.Code -ceq 'anchor_not_found')
    $r = Read-ApprovalAnchor -Path (Join-Path $pdir 'absent-dir\anchor.json')
    Test-Case 'path: a missing parent directory gives anchor_not_found' (-not $r.Ok -and $r.Code -ceq 'anchor_not_found')
    $r = Read-ApprovalAnchor -Path (Join-Path $good 'inner.json')
    Test-Case 'path: a file used as a directory gives anchor_not_found' (-not $r.Ok -and $r.Code -ceq 'anchor_not_found')
    $dirAsAnchor = Join-Path $pdir 'adir'; [void][IO.Directory]::CreateDirectory($dirAsAnchor)
    $r = Read-ApprovalAnchor -Path $dirAsAnchor
    Test-Case 'path: a directory gives anchor_not_regular_file' (-not $r.Ok -and $r.Code -ceq 'anchor_not_regular_file') "code=$($r.Code)"
    $lockPath = Join-Path $pdir 'locked.json'; Write-AnchorFile $lockPath 2 $H64
    $lockFs = [IO.File]::Open($lockPath, [IO.FileMode]::Open, [IO.FileAccess]::ReadWrite, [IO.FileShare]::None)
    try { $r = Read-ApprovalAnchor -Path $lockPath } finally { $lockFs.Dispose() }
    Test-Case 'path: a file that cannot be opened for reading gives anchor_unreadable' (-not $r.Ok -and $r.Code -ceq 'anchor_unreadable') "code=$($r.Code)"

    # reparse points
    $real = Join-Path $pdir 'real'; [void][IO.Directory]::CreateDirectory($real); Write-AnchorFile (Join-Path $real 'anchor.json') 2 $H64
    $junction = Join-Path $pdir 'junction'
    [void](New-Item -ItemType Junction -Path $junction -Target $real)
    try {
        $r = Read-ApprovalAnchor -Path (Join-Path $junction 'anchor.json')
        Test-Case 'reparse point: a junction in the middle of the path is refused' (-not $r.Ok -and $r.Code -ceq 'anchor_path_reparse_point') "code=$($r.Code)"
        $r = Read-ApprovalAnchor -Path $junction
        Test-Case 'reparse point: a junction as the last component is refused as a reparse point' (-not $r.Ok -and $r.Code -ceq 'anchor_path_reparse_point') "code=$($r.Code)"
    } finally { [IO.Directory]::Delete($junction) }
    $symlink = Join-Path $pdir 'symlink.json'
    $canSymlink = $true
    try { [void](New-Item -ItemType SymbolicLink -Path $symlink -Target (Join-Path $real 'anchor.json') -ErrorAction Stop) } catch { $canSymlink = $false }
    if ($canSymlink) {
        $r = Read-ApprovalAnchor -Path $symlink
        Test-Case 'reparse point: a symbolic link to a valid anchor file is refused' (-not $r.Ok -and $r.Code -ceq 'anchor_path_reparse_point') "code=$($r.Code)"
    } else { Write-Host 'NOT MEASURED: symbolic links cannot be created under these rights' -ForegroundColor Yellow }
    $hard = Join-Path $pdir 'hardlink.json'
    [void](New-Item -ItemType HardLink -Path $hard -Target (Join-Path $real 'anchor.json'))
    $r = Read-ApprovalAnchor -Path $hard
    Test-Case 'documented limit: a hard link is not detected and the file is read (the format and the hash comparison still apply)' ($r.Ok -and $r.Anchor.seq -eq 2)

    # ---------------------------------------------------------------------------------------------------------------
    # 3. Verification with an anchor: what is detected and what is not
    $vdir = Join-Path $root 'verify'; [void][IO.Directory]::CreateDirectory($vdir)
    $store = New-TestStore $vdir 5
    $h3 = Get-HashAt $store 3; $h5 = Get-HashAt $store 5; $h4 = Get-HashAt $store 4
    $a3 = Join-Path $vdir 'anchor3.json'; Write-AnchorFile $a3 3 $h3
    $a5 = Join-Path $vdir 'anchor5.json'; Write-AnchorFile $a5 5 $h5
    $none = Test-ApprovalStore -StorePath $store
    Test-Case 'report without an anchor: only internal consistency, tail truncation not checked, no completeness claim' ($none.Ok -and $none.TailTruncation -ceq 'not_checked' -and $none.AnchorStatus -ceq 'none' -and $null -eq $none.AnchorSeq -and $none.Note -match 'not mean that the store is complete')
    $v3 = Test-ApprovalStore -StorePath $store -AnchorPath $a3
    Test-Case 'report with an anchor at seq 3 of 5: ok, protection limited to the anchor, two records after it' ($v3.Ok -and $v3.TailTruncation -ceq 'checked_to_anchor_only' -and $v3.AnchorStatus -ceq 'applied' -and $v3.AnchorSeq -eq 3 -and $v3.RecordsAfterAnchor -eq 2)
    Test-Case 'report with an anchor: the note limits the claim (after the anchor, rollback, simultaneous edit, human storage, no completeness)' ($v3.Note -match 'internal consistency only' -and $v3.Note -match 'rollback' -and $v3.Note -match 'simultaneous edit' -and $v3.Note -match 'independent storage' -and $v3.Note -match 'not mean that the store is complete')
    Test-Case 'report: the misleading value excluded_by_anchor is not produced any more' ($none.TailTruncation -cne 'excluded_by_anchor' -and $v3.TailTruncation -cne 'excluded_by_anchor')
    $v5 = Test-ApprovalStore -StorePath $store -AnchorPath $a5
    Test-Case 'anchor at the last record: ok, no record after the anchor' ($v5.Ok -and $v5.RecordsAfterAnchor -eq 0)
    $objAnchor = Test-ApprovalStore -StorePath $store -Anchor ([ordered]@{ seq = [long]3; hash = $h3 })
    Test-Case 'compatibility: the existing -Anchor object (seq, hash) still works and gives the same result' ($objAnchor.Ok -and $objAnchor.TailTruncation -ceq 'checked_to_anchor_only' -and $objAnchor.RecordsAfterAnchor -eq 2)
    $objBad = Test-ApprovalStore -StorePath $store -Anchor ([pscustomobject]@{ seq = 3; hash = $h4 })
    Test-Case 'compatibility: the existing -Anchor object with a wrong hash gives modified at that seq' (-not $objBad.Ok -and (Get-Mismatches $objBad) -ceq '3:modified' -and $objBad.TailTruncation -ceq 'not_checked')
    $both = Test-ApprovalStore -StorePath $store -Anchor ([ordered]@{ seq = [long]3; hash = $h3 }) -AnchorPath $a3
    Test-Case 'an anchor object together with an anchor path is refused' (-not $both.Ok -and $both.AnchorStatus -ceq 'rejected')

    # no fallback
    foreach ($bad in @(@{ N = 'a missing anchor file'; P = (Join-Path $vdir 'absent.json') }, @{ N = 'an empty path'; P = '' }, @{ N = 'a null path'; P = $null }, @{ N = 'a malformed anchor'; P = (Join-Path $fdir 'bad1.json') })) {
        $rv = Test-ApprovalStore -StorePath $store -AnchorPath $bad.P
        Test-Case "no fallback: $($bad.N) makes the verification not ok and it names a fixed code" (-not $rv.Ok -and $rv.AnchorStatus -ceq 'rejected' -and $rv.AnchorCode -cmatch '^anchor_[a-z_]+$' -and $rv.LineCount -eq 0) "status=$($rv.AnchorStatus) code=$($rv.AnchorCode)"
    }

    # detected: modification before and at the anchor
    $mod = Join-Path $vdir 'modified.jsonl'
    $copy = [IO.File]::ReadAllText($store, $utf8).Replace('Record 2.', 'Record X.')
    [IO.File]::WriteAllText($mod, $copy, $utf8)
    $r = Test-ApprovalStore -StorePath $mod -AnchorPath $a3
    Test-Case 'detected: a record before the anchor is edited (the chain itself reports it)' (-not $r.Ok -and (Get-Mismatches $r) -match '(^|,)2:modified') (Get-Mismatches $r)
    $rech = Join-Path $vdir 'rechained-before.jsonl'
    $o2 = Read-LineObjects $store; $o2[1]['rationale'] = 'Altered before the anchor.'
    Write-RechainedStore $rech $o2
    $plain = Test-ApprovalStore -StorePath $rech
    $r = Test-ApprovalStore -StorePath $rech -AnchorPath $a3
    Test-Case 'detected: an edit before the anchor with the whole chain recomputed (valid without the anchor, modified at the anchored seq with it)' ($plain.Ok -and -not $r.Ok -and (Get-Mismatches $r) -ceq '3:modified') "plain=$($plain.Ok) mm=$(Get-Mismatches $r)"
    $recAt = Join-Path $vdir 'rechained-at.jsonl'
    $o3 = Read-LineObjects $store; $o3[2]['rationale'] = 'Altered at the anchor.'
    Write-RechainedStore $recAt $o3
    $r = Test-ApprovalStore -StorePath $recAt -AnchorPath $a3
    Test-Case 'detected: the anchored record itself edited and re-chained' (-not $r.Ok -and (Get-Mismatches $r) -ceq '3:modified')
    $wrongAnchor = Join-Path $vdir 'wrong.json'; Write-AnchorFile $wrongAnchor 3 $h4
    $r = Test-ApprovalStore -StorePath $store -AnchorPath $wrongAnchor
    Test-Case 'detected: an anchor whose hash belongs to another record gives modified' (-not $r.Ok -and (Get-Mismatches $r) -ceq '3:modified')

    # truncation and rollback
    $lines5 = Get-Lines $store
    $mk = { param($count, $name) $p = Join-Path $vdir $name; [IO.File]::WriteAllText($p, ((($lines5[0..($count - 1)]) -join "`n") + "`n"), $utf8); $p }
    $t2 = & $mk 2 'trunc2.jsonl'
    $r = Test-ApprovalStore -StorePath $t2 -AnchorPath $a3
    Test-Case 'detected: truncation to before the anchored position (2 of 5 records, anchor at 3) gives missing' ((Test-ApprovalStore -StorePath $t2).Ok -and -not $r.Ok -and (Get-Mismatches $r) -ceq '3:missing')
    $t3 = & $mk 3 'trunc3.jsonl'
    $r = Test-ApprovalStore -StorePath $t3 -AnchorPath $a3
    Test-Case 'NOT detected (documented): truncation exactly to the anchored record' ($r.Ok -and $r.RecordsAfterAnchor -eq 0)
    $t4 = & $mk 4 'trunc4.jsonl'
    $r = Test-ApprovalStore -StorePath $t4 -AnchorPath $a3
    Test-Case 'NOT detected (documented): truncation after the anchored record (4 of 5 records, anchor at 3)' ($r.Ok -and $r.RecordsAfterAnchor -eq 1)
    $r = Test-ApprovalStore -StorePath $t4 -AnchorPath $a5
    Test-Case 'detected: the same truncation is found when the anchor sits at the last record (anchor at 5)' (-not $r.Ok -and (Get-Mismatches $r) -ceq '5:missing')
    $t1 = & $mk 1 'rollback1.jsonl'
    $r = Test-ApprovalStore -StorePath $t1 -AnchorPath $a3
    Test-Case 'detected: rollback to an older valid state below the anchored seq' (-not $r.Ok -and (Get-Mismatches $r) -ceq '3:missing')
    $r = Test-ApprovalStore -StorePath $t4 -AnchorPath $a3
    Test-Case 'NOT detected (documented): rollback to an older valid state at or above the anchored seq (4 of 5, anchor at 3)' ($r.Ok)
    $empty = Join-Path $vdir 'empty.jsonl'; [IO.File]::WriteAllBytes($empty, [byte[]]@())
    $r = Test-ApprovalStore -StorePath $empty -AnchorPath $a3
    Test-Case 'detected: an empty store with an anchor gives missing' (-not $r.Ok -and (Get-Mismatches $r) -ceq '3:missing')
    $r = Test-ApprovalStore -StorePath (Join-Path $vdir 'no-such-store.jsonl') -AnchorPath $a3
    Test-Case 'detected: a store file that does not exist, with an anchor, gives missing' (-not $r.Ok -and (Get-Mismatches $r) -ceq '3:missing')
    $beyond = Join-Path $vdir 'beyond.json'; Write-AnchorFile $beyond 9 $h5
    $r = Test-ApprovalStore -StorePath $store -AnchorPath $beyond
    Test-Case 'detected: an anchor seq beyond the last record gives missing' (-not $r.Ok -and (Get-Mismatches $r) -ceq '9:missing')

    # after the anchor
    $after = Join-Path $vdir 'rechained-after.jsonl'
    $o4 = Read-LineObjects $store; $o4[3]['rationale'] = 'Altered after the anchor.'
    Write-RechainedStore $after $o4
    $r = Test-ApprovalStore -StorePath $after -AnchorPath $a3
    Test-Case 'NOT detected (documented): an edit after the anchor with the chain recomputed' ($r.Ok -and $r.RecordsAfterAnchor -eq 2)
    $r = Test-ApprovalStore -StorePath $after -AnchorPath $a5
    Test-Case 'detected: the same edit is found when the anchor is at the last record' (-not $r.Ok -and (Get-Mismatches $r) -ceq '5:modified')
    $r = Test-ApprovalStore -StorePath $mod -AnchorPath $a5
    Test-Case 'a modified store never gets the anchor protection claim (tail truncation stays not_checked)' (-not $r.Ok -and $r.TailTruncation -ceq 'not_checked' -and $r.Note -match 'does not verify')

    # a store_rejection line can be anchored
    $rej = New-TestStore $vdir 2 'withrej.jsonl'
    [void](Invoke-Req $rej ([ordered]@{ operation = 'modify'; attempted_seq = 1 }))
    $ra = Join-Path $vdir 'rejanchor.json'; Write-AnchorFile $ra 3 (Get-HashAt $rej 3)
    $r = Test-ApprovalStore -StorePath $rej -AnchorPath $ra
    Test-Case 'the anchor may name a store_rejection line (it is part of the chain)' ($r.Ok -and $r.AnchorSeq -eq 3)

    # ---------------------------------------------------------------------------------------------------------------
    # 4. Anchored append and the in-process store layer
    $adir = Join-Path $root 'append'; [void][IO.Directory]::CreateDirectory($adir)
    $s = New-TestStore $adir 3
    $anc = Join-Path $adir 'anchor.json'; Write-AnchorFile $anc 3 (Get-HashAt $s 3)
    $ancBefore = [IO.File]::ReadAllBytes($anc); $ancStamp = Get-Stamp $anc
    $r = Invoke-Req $s ([ordered]@{ operation = 'append'; candidate = (New-Candidate 4) }) -AnchorPath $anc -UseAnchor
    Test-Case 'anchored append: stored with the next seq, and the chain verifies against the same anchor' ($r.Outcome -eq 'stored' -and $r.Line['seq'] -eq 4 -and $r.Reason -eq '' -and (Test-ApprovalStore -StorePath $s -AnchorPath $anc).Ok -and (Test-ApprovalStore -StorePath $s -AnchorPath $anc).RecordsAfterAnchor -eq 1)
    Test-Case 'anchored append: the anchor file is byte-identical and was not touched' (Test-BytesEqual $ancBefore ([IO.File]::ReadAllBytes($anc)))
    Test-Case 'anchored append: the anchor file keeps its size and modification time' ((Get-Stamp $anc) -ceq $ancStamp)
    $r = Invoke-Req $s ([ordered]@{ operation = 'append'; candidate = (New-Candidate 5) })
    Test-Case 'append without an anchor behaves as before (stored, empty Reason)' ($r.Outcome -eq 'stored' -and $r.Line['seq'] -eq 5 -and $r.Reason -eq '')

    # mismatch: store diverges from the anchor
    $div = Join-Path $adir 'diverged.jsonl'
    $od = Read-LineObjects $s; $od[0]['rationale'] = 'Altered.'
    Write-RechainedStore $div $od
    $beforeDiv = [IO.File]::ReadAllBytes($div)
    $secretDir = Join-Path $adir 'secret-anchor-dir-q7x'; [void][IO.Directory]::CreateDirectory($secretDir)
    $secretPath = Join-Path $secretDir 'secret-anchor-name-q7x.json'
    $secretHash = 'cd' * 32
    Write-AnchorFile $secretPath 3 $secretHash
    $r = Invoke-Req $div ([ordered]@{ operation = 'append'; candidate = (New-Candidate 9) }) -AnchorPath $secretPath -UseAnchor
    Test-Case 'anchor mismatch: the append is refused as store_invalid with the mismatch, and the store is byte-identical' ($r.Outcome -eq 'store_invalid' -and $r.ExitCode -ne 0 -and (Test-BytesEqual $beforeDiv ([IO.File]::ReadAllBytes($div))) -and -not (Test-Path -LiteralPath ($div + '.tmp'))) "outcome=$($r.Outcome)"
    $leakText = "$($r.Message)|$($r.Reason)|" + (@($r.Report.Mismatches | ForEach-Object { "$($_.Kind):$($_.Detail)" }) -join '|')
    Test-Case 'anchor mismatch: the visible text names neither the path, the directory, nor the hashes' (Test-NoLeak $leakText @($secretPath, $secretDir, 'secret-anchor-name-q7x', $secretHash, (Get-HashAt $div 3)))
    $beforeDiv = [IO.File]::ReadAllBytes($div)
    $rm = Invoke-Req $div ([ordered]@{ operation = 'modify'; attempted_seq = 1 }) -AnchorPath $secretPath -UseAnchor
    $rd = Invoke-Req $div ([ordered]@{ operation = 'delete'; attempted_seq = 1 }) -AnchorPath $secretPath -UseAnchor
    Test-Case 'anchor mismatch: modify and delete requests are refused too, and no store_rejection line is written' ($rm.Outcome -eq 'store_invalid' -and $rd.Outcome -eq 'store_invalid' -and (Test-BytesEqual $beforeDiv ([IO.File]::ReadAllBytes($div))))
    $s2 = New-TestStore $adir 3 'modrej.jsonl'
    $anc2 = Join-Path $adir 'anchor2.json'; Write-AnchorFile $anc2 3 (Get-HashAt $s2 3)
    $rm2 = Invoke-Req $s2 ([ordered]@{ operation = 'modify'; attempted_seq = 1 }) -AnchorPath $anc2 -UseAnchor
    Test-Case 'a valid anchor does not change the store_rejection contract (a modify request appends its rejection line)' ($rm2.Outcome -eq 'refused' -and $rm2.Line['type'] -ceq 'store_rejection' -and (Get-Lines $s2).Count -eq 4 -and (Test-ApprovalStore -StorePath $s2 -AnchorPath $anc2).Ok)

    # anchor not usable: every code, store untouched, nothing leaks
    $bigFile = Join-Path $adir 'big.json'; [IO.File]::WriteAllBytes($bigFile, [byte[]]::new(5000))
    $badFile = Join-Path $adir 'badformat.json'; [IO.File]::WriteAllText($badFile, '{"seq":1}', $utf8)
    $dirOnly = Join-Path $adir 'adir'; [void][IO.Directory]::CreateDirectory($dirOnly)
    $junctionDir = Join-Path $adir 'real'; [void][IO.Directory]::CreateDirectory($junctionDir); Write-AnchorFile (Join-Path $junctionDir 'a.json') 3 (Get-HashAt $s 3)
    $jn = Join-Path $adir 'jn'; [void](New-Item -ItemType Junction -Path $jn -Target $junctionDir)
    $unusable = @(
        @{ Name = 'missing file'; Path = (Join-Path $adir 'missing-q7x.json'); Code = 'anchor_not_found' },
        @{ Name = 'malformed content'; Path = $badFile; Code = 'anchor_malformed' },
        @{ Name = 'too large'; Path = $bigFile; Code = 'anchor_too_large' },
        @{ Name = 'a directory'; Path = $dirOnly; Code = 'anchor_not_regular_file' },
        @{ Name = 'a relative path'; Path = 'relative-q7x.json'; Code = 'anchor_path_invalid' },
        @{ Name = 'an empty path'; Path = ''; Code = 'anchor_path_invalid' },
        @{ Name = 'a path in the repository'; Path = (Join-Path $repo 'package.json'); Code = 'anchor_path_in_repository' },
        @{ Name = 'a path through a junction'; Path = (Join-Path $jn 'a.json'); Code = 'anchor_path_reparse_point' }
    )
    try {
        foreach ($u in $unusable) {
            $before = [IO.File]::ReadAllBytes($s)
            $r = Invoke-Req $s ([ordered]@{ operation = 'append'; candidate = (New-Candidate 6) }) -AnchorPath $u.Path -UseAnchor
            $text = "$($r.Outcome)|$($r.Message)|$($r.Reason)"
            Test-Case "anchor not usable ($($u.Name)): refused as anchor_rejected with $($u.Code), store byte-identical, no fallback to no anchor" ($r.Outcome -eq 'anchor_rejected' -and $r.Reason -ceq $u.Code -and $r.ExitCode -ne 0 -and (Test-BytesEqual $before ([IO.File]::ReadAllBytes($s))) -and -not (Test-Path -LiteralPath ($s + '.tmp')) -and (Test-NoLeak $text @($u.Path, $adir, 'q7x'))) "outcome=$($r.Outcome) reason=$($r.Reason)"
        }
    } finally { [IO.Directory]::Delete($jn) }
    $nostore = Join-Path $adir 'never-created.jsonl'
    $r = Invoke-Req $nostore ([ordered]@{ operation = 'append'; candidate = (New-Candidate 1) }) -AnchorPath $anc -UseAnchor
    Test-Case 'an anchored append to a store that does not exist is refused (missing anchored record) and the store is not created' ($r.Outcome -eq 'store_invalid' -and -not (Test-Path -LiteralPath $nostore) -and (Get-Mismatches $r.Report) -ceq '3:missing')
    $r = Invoke-Req $nostore ([ordered]@{ operation = 'append'; candidate = (New-Candidate 1) })
    Test-Case 'an append without an anchor to a store that does not exist still creates it (existing behaviour)' ($r.Outcome -eq 'stored' -and (Test-Path -LiteralPath $nostore))
    Test-Case 'the anchor files of this section are unchanged by every request above' ((Test-BytesEqual $ancBefore ([IO.File]::ReadAllBytes($anc))) -and (Get-Stamp $anc) -ceq $ancStamp)

    # ---------------------------------------------------------------------------------------------------------------
    # 5. The store is compared again immediately before the write (under the store mutex)
    $wdir = Join-Path $root 'prewrite'; [void][IO.Directory]::CreateDirectory($wdir)
    $runTarget = [ordered]@{ kind = 'run'; run_id = 'run-0001' }
    $req = { param($i) [ordered]@{ operation = 'append'; candidate = (New-Candidate $i $runTarget) } }
    $injected = $utf8.GetBytes("injected by another process`n")

    $w = Join-Path $wdir 'absent-ok.jsonl'
    $r = Invoke-Req $w (& $req 1) { param($t) $true }
    Test-Case 'pre-write: a store that is absent at the start and still absent is created (stored)' ($r.Outcome -eq 'stored' -and (Test-Path -LiteralPath $w) -and (Get-Lines $w).Count -eq 1)

    $w = Join-Path $wdir 'absent-created.jsonl'
    $r = Invoke-Req $w (& $req 1) { param($t) [IO.File]::WriteAllBytes($w, $injected); $true }
    Test-Case 'pre-write: a store created after the verification gives store_created, and the created file is not overwritten' ($r.Outcome -eq 'store_changed' -and $r.Reason -ceq 'store_created' -and $r.ExitCode -ne 0 -and (Test-BytesEqual $injected ([IO.File]::ReadAllBytes($w))) -and -not (Test-Path -LiteralPath ($w + '.tmp'))) "outcome=$($r.Outcome) reason=$($r.Reason)"

    $w = Join-Path $wdir 'absent-created-empty.jsonl'
    $r = Invoke-Req $w (& $req 1) { param($t) [IO.File]::WriteAllBytes($w, [byte[]]@()); $true }
    Test-Case 'pre-write: an empty store created after the verification is still a creation (absent and empty are different states)' ($r.Outcome -eq 'store_changed' -and $r.Reason -ceq 'store_created' -and (Get-Item -LiteralPath $w).Length -eq 0)

    $w = New-TestStore $wdir 2 'exists-ok.jsonl'
    $r = Invoke-Req $w (& $req 3) { param($t) $true }
    Test-Case 'pre-write: a store that exists at the start and is unchanged is extended (stored)' ($r.Outcome -eq 'stored' -and $r.Line['seq'] -eq 3 -and (Test-ApprovalStore -StorePath $w).Ok)

    $w = New-TestStore $wdir 2 'deleted.jsonl'
    $r = Invoke-Req $w (& $req 3) { param($t) [IO.File]::Delete($w); $true }
    Test-Case 'pre-write: a store deleted after the verification gives store_deleted and is not recreated' ($r.Outcome -eq 'store_changed' -and $r.Reason -ceq 'store_deleted' -and -not (Test-Path -LiteralPath $w) -and -not (Test-Path -LiteralPath ($w + '.tmp')))

    $w = Join-Path $wdir 'deleted-empty.jsonl'; [IO.File]::WriteAllBytes($w, [byte[]]@())
    $r = Invoke-Req $w (& $req 1) { param($t) [IO.File]::Delete($w); $true }
    Test-Case 'pre-write: an empty store that is deleted gives store_deleted (an existing empty file is not the same as no file)' ($r.Outcome -eq 'store_changed' -and $r.Reason -ceq 'store_deleted' -and -not (Test-Path -LiteralPath $w))

    $w = New-TestStore $wdir 2 'modified-append.jsonl'
    $origLen = (Get-Item -LiteralPath $w).Length
    $r = Invoke-Req $w (& $req 3) { param($t) $fs = [IO.File]::Open($w, [IO.FileMode]::Append); $b = $utf8.GetBytes("x"); $fs.Write($b, 0, 1); $fs.Dispose(); $true }
    $changed = [IO.File]::ReadAllBytes($w)
    Test-Case 'pre-write: bytes appended after the verification give store_modified, and the changed store is not overwritten' ($r.Outcome -eq 'store_changed' -and $r.Reason -ceq 'store_modified' -and $changed.Length -eq ($origLen + 1) -and $changed[$changed.Length - 1] -eq [byte][char]'x')

    $w = New-TestStore $wdir 2 'modified-same-length.jsonl'
    $r = Invoke-Req $w (& $req 3) { param($t) $x = [IO.File]::ReadAllBytes($w); $x[10] = [byte]($x[10] -bxor 1); [IO.File]::WriteAllBytes($w, $x); $true }
    Test-Case 'pre-write: a change that keeps the length (one flipped bit) is found' ($r.Outcome -eq 'store_changed' -and $r.Reason -ceq 'store_modified')

    $w = New-TestStore $wdir 2 'rewritten-same.jsonl'
    $r = Invoke-Req $w (& $req 3) { param($t) [IO.File]::WriteAllBytes($w, [IO.File]::ReadAllBytes($w)); $true }
    Test-Case 'pre-write: a rewrite with identical bytes is not a change (the comparison is on bytes)' ($r.Outcome -eq 'stored')

    $w = New-TestStore $wdir 3 'anchored-modified.jsonl'
    $wa = Join-Path $wdir 'anchored-modified.json'; Write-AnchorFile $wa 3 (Get-HashAt $w 3)
    $r = Invoke-Req $w (& $req 4) { param($t) $x = [IO.File]::ReadAllBytes($w); $x[10] = [byte]($x[10] -bxor 1); [IO.File]::WriteAllBytes($w, $x); $true } -AnchorPath $wa -UseAnchor
    Test-Case 'pre-write with an anchor: a store changed after the anchored verification is not overwritten either' ($r.Outcome -eq 'store_changed' -and $r.Reason -ceq 'store_modified')

    $w = New-TestStore $wdir 1 'under-mutex.jsonl'
    $probe = @{ held = $null }
    $r = Invoke-Req $w (& $req 2) {
        param($t)
        $job = Start-ThreadJob -ScriptBlock { param($name) $m = [System.Threading.Mutex]::new($false, $name); try { $m.WaitOne(0) } finally { $m.Dispose() } } -ArgumentList $mutexName
        $probe.held = [bool](Receive-Job -Job $job -Wait -AutoRemoveJob)
        $true
    }
    Test-Case 'pre-write: the check runs under the store mutex (another thread cannot take it at that moment)' ($r.Outcome -eq 'stored' -and $probe.held -eq $false)

    $w = New-TestStore $wdir 2 'normal-atomic.jsonl'
    $r = Invoke-Req $w (& $req 3) { param($t) $true }
    Test-Case 'a normal append keeps the atomic write: no temporary file is left, the chain verifies' ($r.Outcome -eq 'stored' -and -not (Test-Path -LiteralPath ($w + '.tmp')) -and (Test-ApprovalStore -StorePath $w).Ok)

    # ---------------------------------------------------------------------------------------------------------------
    # 6. The command (process level)
    $cdir = Join-Path $root 'command'; [void][IO.Directory]::CreateDirectory($cdir)
    $cs = New-TestStore $cdir 3
    $ca = Join-Path $cdir 'anchor.json'; Write-AnchorFile $ca 2 (Get-HashAt $cs 2)
    $caBytes = [IO.File]::ReadAllBytes($ca); $caStamp = Get-Stamp $ca
    $v = Invoke-ChildPwsh $addCommand @('-Verify', '-StorePath', $cs, '-AnchorPath', $ca)
    Test-Case 'command -Verify -AnchorPath: exit 0, reports the anchor seq and the unprotected records after it' ($v.ExitCode -eq 0 -and $v.Output -match 'anchor: seq 2 compared' -and $v.Output -match 'after the anchor.*: 1' -and $v.Output -match 'checked_to_anchor_only' -and $v.Output -match 'not mean that the store is complete') $v.Output
    $v = Invoke-ChildPwsh $addCommand @('-Verify', '-StorePath', $cs)
    Test-Case 'command -Verify without an anchor: unchanged behaviour (exit 0, tail truncation not_checked)' ($v.ExitCode -eq 0 -and $v.Output -match 'tail truncation: not_checked' -and $v.Output -match 'not mean that the store is complete')
    $cdiv = Join-Path $cdir 'diverged.jsonl'
    $oc = Read-LineObjects $cs; $oc[1]['rationale'] = 'Altered.'
    Write-RechainedStore $cdiv $oc
    $v = Invoke-ChildPwsh $addCommand @('-Verify', '-StorePath', $cdiv, '-AnchorPath', $ca)
    Test-Case 'command -Verify -AnchorPath: an anchor mismatch exits non-zero and reports seq and kind' ($v.ExitCode -ne 0 -and $v.Error -match 'seq 2 kind modified') $v.Error
    $csecret = Join-Path $cdir 'cmd-secret-name-k3z.json'; Write-AnchorFile $csecret 2 $secretHash
    $v = Invoke-ChildPwsh $addCommand @('-Verify', '-StorePath', $cs, '-AnchorPath', (Join-Path $cdir 'cmd-missing-k3z.json'))
    Test-Case 'command -Verify -AnchorPath: a missing anchor exits 2 with a fixed code, no fallback, and no path in the output' ($v.ExitCode -eq 2 -and $v.Error -match 'anchor_rejected: anchor_not_found' -and (Test-NoLeak ($v.Output + $v.Error) @($cdir, 'k3z', 'phx-test')) -and $v.Output -notmatch 'tail truncation') "$($v.Output) $($v.Error)"
    $v = Invoke-ChildPwsh $addCommand @('-Verify', '-StorePath', $cs, '-AnchorPath', '')
    Test-Case 'command -Verify -AnchorPath with an empty value is refused, not ignored' ($v.ExitCode -eq 2 -and $v.Error -match 'anchor_rejected: anchor_path_invalid')
    $v = Invoke-ChildPwsh $addCommand @('-Verify', '-StorePath', $cs, '-AnchorPath', $csecret)
    Test-Case 'command -Verify -AnchorPath: a well-formed anchor with a wrong hash is a mismatch and the output names neither path nor hash' ($v.ExitCode -ne 0 -and $v.Error -match 'seq 2 kind modified' -and (Test-NoLeak ($v.Output + $v.Error) @($cdir, 'k3z', $secretHash)))

    $before = [IO.File]::ReadAllBytes($cs)
    $ap = Invoke-ChildPwsh $addCommand @('-Approver', 'Cmd Approver', '-Decision', 'approved', '-Target', 'gate:m6-start', '-Rationale', 'Anchored append.', '-Actor', 'human', '-StorePath', $cs, '-AnchorPath', $ca)
    Test-Case 'command append with -AnchorPath: stored (a record after the anchor is allowed) and the chain still verifies against the anchor' ($ap.ExitCode -eq 0 -and (Get-Lines $cs).Count -eq 4 -and (Test-ApprovalStore -StorePath $cs -AnchorPath $ca).Ok) $ap.Error
    $before = [IO.File]::ReadAllBytes($cs)
    $refusals = @(
        @{ Name = 'a missing anchor'; Anchor = (Join-Path $cdir 'cmd-missing-k3z.json'); Err = 'anchor_not_found' },
        @{ Name = 'an empty anchor path'; Anchor = ''; Err = 'anchor_path_invalid' },
        @{ Name = 'a malformed anchor'; Anchor = $badFile; Err = 'anchor_malformed' },
        @{ Name = 'a relative anchor path'; Anchor = 'anchor.json'; Err = 'anchor_path_invalid' },
        @{ Name = 'an anchor in the repository'; Anchor = (Join-Path $repo 'package.json'); Err = 'anchor_path_in_repository' }
    )
    foreach ($c in $refusals) {
        $x = Invoke-ChildPwsh $addCommand @('-Approver', 'Cmd Approver', '-Decision', 'approved', '-Target', 'gate:m6-start', '-Rationale', 'Refused.', '-Actor', 'human', '-StorePath', $cs, '-AnchorPath', $c.Anchor)
        Test-Case "command append with $($c.Name): refused with $($c.Err), store byte-identical" ($x.ExitCode -ne 0 -and $x.Error -match "reason: $($c.Err)" -and (Test-BytesEqual $before ([IO.File]::ReadAllBytes($cs))) -and (Test-NoLeak ($x.Output + $x.Error) @($cdir, 'k3z', $c.Anchor -replace '^$', "`0")) -and -not (Test-Path -LiteralPath ($cs + '.tmp'))) "exit=$($x.ExitCode) $($x.Error)"
    }
    $x = Invoke-ChildPwsh $addCommand @('-Approver', 'Cmd Approver', '-Decision', 'approved', '-Target', 'gate:m6-start', '-Rationale', 'Mismatch.', '-Actor', 'human', '-StorePath', $cdiv, '-AnchorPath', $ca)
    Test-Case 'command append with an anchor mismatch: refused with store_invalid and the store is byte-identical' ($x.ExitCode -ne 0 -and $x.Error -match 'store_invalid' -and $x.Error -match 'seq 2 kind modified') $x.Error
    $x = Invoke-ChildPwsh $addCommand @('-Approver', 'Cmd Approver', '-Decision', 'approved', '-Target', 'gate:m6-start', '-Rationale', 'No anchor.', '-Actor', 'human', '-StorePath', $cs)
    Test-Case 'command append without -AnchorPath: unchanged behaviour (stored)' ($x.ExitCode -eq 0 -and (Get-Lines $cs).Count -eq 5)
    $x = Invoke-ChildPwsh $addCommand @('-Approver', 'A', '-Decision', 'maybe', '-Target', 'gate:m6-start', '-Rationale', 'R.', '-Actor', 'human', '-StorePath', $cs, '-AnchorPath', $ca)
    Test-Case 'command: an invalid record with a valid anchor is still named field by field and leaves the store unchanged' ($x.ExitCode -ne 0 -and $x.Error -match 'invalid field: decision' -and (Get-Lines $cs).Count -eq 5)
    Test-Case 'command: the anchor file is byte-identical and untouched after every command above' ((Test-BytesEqual $caBytes ([IO.File]::ReadAllBytes($ca))) -and (Get-Stamp $ca) -ceq $caStamp)

    # concurrency with an anchor
    $ds = New-TestStore $cdir 1 'concurrent.jsonl'
    $da = Join-Path $cdir 'concurrent-anchor.json'; Write-AnchorFile $da 1 (Get-HashAt $ds 1)
    $jobs = 1..4 | ForEach-Object {
        $i = $_
        Start-ThreadJob -ScriptBlock {
            param($cmd, $store, $anchor, $i)
            $psi = [System.Diagnostics.ProcessStartInfo]::new((Get-Process -Id $PID).Path)
            foreach ($a in @('-NoProfile', '-NonInteractive', '-File', $cmd, '-Approver', "Concurrent $i", '-Decision', 'approved', '-Target', 'gate:m6-start', '-Rationale', "Run $i.", '-Actor', 'human', '-StorePath', $store, '-AnchorPath', $anchor)) { $psi.ArgumentList.Add($a) }
            $psi.RedirectStandardOutput = $true; $psi.RedirectStandardError = $true; $psi.UseShellExecute = $false
            $p = [System.Diagnostics.Process]::Start($psi); $p.WaitForExit(); $p.ExitCode
        } -ArgumentList $addCommand, $ds, $da, $i
    }
    $codes = @($jobs | Wait-Job | Receive-Job); $jobs | Remove-Job
    $seqs = @(Get-Lines $ds | ForEach-Object { (ConvertFrom-JsonStrict -Text $_)['seq'] })
    Test-Case 'concurrency with an anchor: four concurrent anchored appends give seq 1 to 5 and a chain that verifies against the anchor' ((@($codes | Where-Object { $_ -ne 0 }).Count -eq 0) -and (($seqs -join ',') -eq '1,2,3,4,5') -and (Test-ApprovalStore -StorePath $ds -AnchorPath $da).Ok) "codes=$($codes -join ',') seqs=$($seqs -join ',')"

    # ---------------------------------------------------------------------------------------------------------------
    # 7. Static checks and scope
    $anchorSrcPath = Join-Path $script:ToolsDir 'ApprovalAnchor.psm1'
    $anchorSrc = Get-Content -Raw -LiteralPath $anchorSrcPath
    $anchorCode = (($anchorSrc -split "`n") | Where-Object { $_ -notmatch '^\s*#' }) -join "`n"
    $writeApi = '\[(System\.)?IO\.File\]::(Write|Append|Replace|Move|Copy|Delete|Create|Set)|FileMode\]::(Create|CreateNew|Append|Truncate|OpenOrCreate)|FileAccess\]::(Write|ReadWrite)|Set-Content|Add-Content|Out-File|New-Item|Remove-Item|Move-Item|Copy-Item|Rename-Item|Clear-Content|Set-ItemProperty'
    Test-Case 'static: ApprovalAnchor.psm1 contains no file-write API (it only reads)' ($anchorCode -notmatch $writeApi)
    Test-Case 'static: ApprovalAnchor.psm1 opens the anchor for reading only, with a bounded read loop, and never reads the whole file at once' ($anchorCode -match 'FileAccess\]::Read,' -and $anchorCode -match '\$fs\.Read\(\$buffer, \$total, \$limit - \$total\)' -and $anchorCode -notmatch 'ReadAll(Bytes|Text|Lines)|CopyTo|Get-Content')
    Test-Case 'static: ApprovalAnchor.psm1 returns fixed codes and never interpolates an exception message or a path into a result' ($anchorCode -notmatch 'Exception\.Message|\$_\.Exception|\$_\.ToString|Write-Error|throw ')
    $toolFiles = Get-ChildItem -LiteralPath $script:ToolsDir -File -Include *.ps1, *.psm1 -Recurse
    $anchorWriters = @($toolFiles | Where-Object { (Get-Content -Raw -LiteralPath $_.FullName) -match '(New|Set|Write|Update|Remove|Save)-ApprovalAnchor' } | ForEach-Object { $_.Name })
    Test-Case 'static: no tool defines or calls an anchor writer (New/Set/Write/Update/Remove/Save-ApprovalAnchor)' ($anchorWriters.Count -eq 0) ($anchorWriters -join ',')
    Test-Case 'static: no Set-ApprovalAnchor.ps1 exists' (-not (Test-Path -LiteralPath (Join-Path $script:ToolsDir 'Set-ApprovalAnchor.ps1')))
    $storeSrc = Get-Content -Raw -LiteralPath (Join-Path $script:ToolsDir 'ApprovalStore.psm1')
    Test-Case 'static: ApprovalStore.psm1 only reads the anchor (Read-ApprovalAnchor) and has no environment-variable or default anchor path' ($storeSrc -match 'Read-ApprovalAnchor' -and $storeSrc -notmatch '\$env:' -and $storeSrc -notmatch 'AnchorPath\s*=\s*[''"]')
    $addText = Get-Content -Raw -LiteralPath $addCommand
    $tokens = $null; $errors = $null
    $ast = [System.Management.Automation.Language.Parser]::ParseFile($addCommand, [ref]$tokens, [ref]$errors)
    $anchorParam = @($ast.ParamBlock.Parameters | Where-Object { $_.Name.VariablePath.UserPath -eq 'AnchorPath' })
    Test-Case 'static: Add-ApprovalRecord.ps1 declares -AnchorPath as an optional string without a default value, and passes it whenever it is bound' ($anchorParam.Count -eq 1 -and $null -eq $anchorParam[0].DefaultValue -and $addText -match "PSBoundParameters\.ContainsKey\('AnchorPath'\)")
    $strTokens = @($tokens | Where-Object { $_.Kind -in 'StringLiteral', 'StringExpandable' } | ForEach-Object { $_.Text })
    $st = $null; $se = $null; $sast = [System.Management.Automation.Language.Parser]::ParseFile((Join-Path $script:ToolsDir 'ApprovalStore.psm1'), [ref]$st, [ref]$se)
    $strTokens += @($st | Where-Object { $_.Kind -in 'StringLiteral', 'StringExpandable' } | ForEach-Object { $_.Text })
    Test-Case 'static: no anchor file name, default location or environment variable is configured in the code of the command or the store module' (@($strTokens | Where-Object { $_ -match 'json' -and $_ -notmatch 'jsonl' -or $_ -cmatch '[A-Za-z]:\\' }).Count -eq 0 -and $anchorCode -notmatch '\$env:') (($strTokens | Where-Object { $_ -match 'json' }) -join ';')
    $selfText = Get-Content -Raw -LiteralPath $PSCommandPath
    Test-Case 'static: this test never names the real approval directory' (-not ($selfText -match ('discovery[/\\]' + 'approvals')))
}
