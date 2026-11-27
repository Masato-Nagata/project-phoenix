#Requires -Version 7.0
# Approval target resolution (task 4.10, part B3b): discovery/tools/ApprovalTargetResolver.psm1 and its wiring in Add-ApprovalRecord.ps1.
# Synthetic data only. Every Run, store, anchor and repository layout is created in a temporary directory outside the repository; the
# command-line cases run a COPY of the tools in a temporary repository layout, so the default runs directory is a temporary one. No Docker,
# no network, no real Run, no real Approval_Store, no real anchor, no Launcher, no configuration. Junctions (the only links created) are
# made inside temporary directories and point at temporary directories.
# The bounded verification itself is tested in test_run_verification_bounded.ps1; here only that it is called and that its failures
# become refusals. Cases of the command line use the store mutex of the command (as the existing command tests do); the in-process cases use their own mutex name.
. (Join-Path $PSScriptRoot 'lib/testlib.ps1')
Import-Module (Join-Path $script:ToolsDir 'DiscoveryCommon.psm1') -Force -DisableNameChecking
Import-Module (Join-Path $script:ToolsDir 'ApprovalStore.psm1') -Force -DisableNameChecking
Import-Module (Join-Path $script:ToolsDir 'ApprovalTargetResolver.psm1') -Force -DisableNameChecking
$utf8 = [System.Text.UTF8Encoding]::new($false)
$script:Mutex = 'Local\PhoenixApprovalTargetsTest-' + [guid]::NewGuid().ToString('N')
$script:Links = [System.Collections.Generic.List[string]]::new()
$script:FailResults = [System.Collections.Generic.List[object]]::new()
$G = '0' * 64
$R1 = 'run-20261201T120000Z-aaaaaaaaaaaa'
$R2 = 'run-20261201T120001Z-bbbbbbbbbbbb'
$REMOVE = '__REMOVE__'

function Get-Bid {
    param([int]$N)
    'run-' + ([datetime]::new(2026, 12, 2, 0, 0, 0, [System.DateTimeKind]::Utc)).AddSeconds($N).ToString("yyyyMMdd'T'HHmmss'Z'", [System.Globalization.CultureInfo]::InvariantCulture) + '-' + $N.ToString('x12')
}
function New-ClaimEntry {
    param([string]$ClaimId = 'clm-0001', [long]$Revision = 1, [hashtable]$Over = @{})
    $e = [ordered]@{
        claimId = $ClaimId; claimRevisionId = ($ClaimId + '-r' + $Revision); revision = $Revision; semanticSha256 = ('a' * 64)
        claim = [ordered]@{ condition = 'synthetic' }; aiStated = [ordered]@{ confidence = 'medium'; openQuestions = @('q') }; origin = 'ai-inferred'
    }
    if ($Revision -gt 1) { $e['predecessorRevision'] = [long]($Revision - 1) }
    foreach ($k in $Over.Keys) { if ($Over[$k] -is [string] -and $Over[$k] -ceq $REMOVE) { $e.Remove($k) } else { $e[$k] = $Over[$k] } }
    $e
}
function New-HypRec {
    param([long]$Index, $Claims)
    @{ Kind = 'hypothesis_revision'; Payload = [ordered]@{ hypothesisId = ('hyp-' + $Index); revision = $Index; derived = @(); tables = @(); claims = @($Claims); promptedByEvidence = @() } }
}
# clm-0001 has two revisions (r1, r2), clm-0002 one.
function Get-StdRecords {
    @(
        @{ Kind = 'run_started'; Payload = [ordered]@{ n = [long]1 } },
        (New-HypRec 1 @((New-ClaimEntry 'clm-0001' 1), (New-ClaimEntry 'clm-0002' 1))),
        (New-HypRec 2 @((New-ClaimEntry 'clm-0001' 2))),
        @{ Kind = 'error'; Payload = [ordered]@{ n = [long]2 } }
    )
}
function New-SynthRun {
    param([string]$RunsRoot, [string]$RunId, $Records = $null, [hashtable]$ManifestOver = @{}, [switch]$NoComplete, [string]$CompleteText = '')
    if ($null -eq $Records) { $Records = Get-StdRecords }
    $dir = Join-Path $RunsRoot $RunId
    [void][IO.Directory]::CreateDirectory($dir)
    $prev = $G; $sb = [System.Text.StringBuilder]::new(); $n = 0
    foreach ($r in @($Records)) {
        $n++
        $body = [ordered]@{ schemaVersion = [long]1; seq = [long]$n; id = ('rec-{0:D6}' -f $n); kind = $r.Kind; prevHash = $prev; payload = $r.Payload }
        if ($r.ContainsKey('Extra')) { foreach ($k in $r.Extra.Keys) { $body[$k] = $r.Extra[$k] } }
        $h = Get-Sha256HexOfText -Text (ConvertTo-CanonicalJson -Value $body)
        $full = [ordered]@{ hash = $h }
        foreach ($k in $body.Keys) { $full[$k] = $body[$k] }
        [void]$sb.Append((ConvertTo-CanonicalJson -Value $full)).Append("`n")
        $prev = $h
    }
    $recBytes = $utf8.GetBytes($sb.ToString())
    [IO.File]::WriteAllBytes((Join-Path $dir 'records.jsonl'), $recBytes)
    $manifest = [ordered]@{ runId = $RunId; artifacts = @([ordered]@{ path = 'records.jsonl'; sha256 = (Get-Sha256Hex -Bytes $recBytes) }); chain = [ordered]@{ records = [long]$n; lastHash = $prev } }
    foreach ($k in $ManifestOver.Keys) { if ($null -eq $ManifestOver[$k]) { $manifest.Remove($k) } else { $manifest[$k] = $ManifestOver[$k] } }
    $mBytes = $utf8.GetBytes((ConvertTo-CanonicalJson -Value $manifest) + "`n")
    [IO.File]::WriteAllBytes((Join-Path $dir 'manifest.json'), $mBytes)
    if (-not $NoComplete) { [IO.File]::WriteAllText((Join-Path $dir 'COMPLETE'), $(if ($CompleteText) { $CompleteText } else { Get-Sha256Hex -Bytes $mBytes })) }
    $dir
}
# Rewrites manifest.json with changed top-level values and rewrites COMPLETE, so the Run stays a valid completed Run with another manifest hash.
function Update-SynthManifest {
    param([string]$Dir, [hashtable]$Over)
    $mp = Join-Path $Dir 'manifest.json'
    $m = ConvertFrom-JsonStrict -Text ($utf8.GetString([IO.File]::ReadAllBytes($mp)).TrimEnd("`n"))
    foreach ($k in $Over.Keys) { $m[$k] = $Over[$k] }
    $b = $utf8.GetBytes((ConvertTo-CanonicalJson -Value $m) + "`n")
    [IO.File]::WriteAllBytes($mp, $b)
    [IO.File]::WriteAllText((Join-Path $Dir 'COMPLETE'), (Get-Sha256Hex -Bytes $b))
}
function Get-ManifestHash { param([string]$Dir) Get-Sha256HexOfFile -Path (Join-Path $Dir 'manifest.json') }
# The time of a DIRECTORY is taken from Get-Item (its actual value): the value of a directory listing can lag behind for a freshly generated
# fixture until the directory is opened (measured in B3b, evidence r-03). Files keep the values of the listing, as before.
function Get-Snapshot {
    param([string]$Dir)
    (Get-ChildItem -LiteralPath $Dir -Recurse -Force | Sort-Object FullName | ForEach-Object {
            if ($_.PSIsContainer) { "D|$($_.FullName.Substring($Dir.Length))|$((Get-Item -LiteralPath $_.FullName -Force).LastWriteTimeUtc.Ticks)" }
            else { "F|$($_.FullName.Substring($Dir.Length))|$($_.Length)|$((Get-FileHash -LiteralPath $_.FullName).Hash)|$($_.LastWriteTimeUtc.Ticks)" }
        }) -join "`n"
}
function New-Link {
    param([string]$Path, [string]$Target)
    $o = cmd /c mklink /J "$Path" "$Target" 2>&1
    if ($LASTEXITCODE -ne 0) { throw "mklink /J failed: $o" }
    $script:Links.Add($Path)
}
function Remove-Links {
    foreach ($l in $script:Links) { try { [IO.Directory]::Delete($l) } catch { } }
    $script:Links.Clear()
}
function RunT { param($Id) [ordered]@{ kind = 'run'; run_id = $Id } }
function ClaimT { param($Run, $Id) [ordered]@{ kind = 'claim_revision'; run_id = $Run; claim_revision_id = $Id } }
function GateT { [ordered]@{ kind = 'gate'; gate_id = 'm6-start' } }
function Chk {
    param($Target, [string]$Root, [hashtable]$Extra = @{})
    $r = Invoke-ApprovalTargetCheck -Target $Target -RunsRoot $Root @Extra
    if (-not $r.Ok) { $script:FailResults.Add($r) }
    $script:LastDiag = "check code=$($r.Code)"
    $r
}
# Diagnostics: a failed case shows the fixed code of the last check or append that its condition evaluated (no path, hash or content).
$script:LastDiag = ''
$script:BaseTestCase = ${function:Test-Case}
function Test-Case {
    param([Parameter(Mandatory)][string]$Name, [Parameter(Mandatory)][bool]$Condition, [string]$Detail = '')
    if (-not $Detail -and $script:LastDiag) { $Detail = $script:LastDiag }
    & $script:BaseTestCase -Name $Name -Condition $Condition -Detail $Detail
    $script:LastDiag = ''
}
function New-Cand {
    param($Target, [hashtable]$Over = @{})
    $c = [ordered]@{ approver = 'Target Approver'; timestamp = '2026-12-01T12:00:00.000+09:00'; target = $Target; decision = 'approved'; rationale = 'Synthetic target test.'; recorded_by = 'human' }
    foreach ($k in $Over.Keys) { if ($null -eq $Over[$k]) { $c.Remove($k) } else { $c[$k] = $Over[$k] } }
    $c
}
function New-StorePath { Join-Path (New-TempDir) 'approvals.jsonl' }
function Invoke-Append {
    param([string]$Store, $Cand, [scriptblock]$Resolver, [string]$AnchorPath)
    $a = @{ StorePath = $Store; Request = [ordered]@{ operation = 'append'; candidate = $Cand }; MutexName = $script:Mutex }
    if ($Resolver) { $a['TargetResolver'] = $Resolver }
    if ($PSBoundParameters.ContainsKey('AnchorPath')) { $a['AnchorPath'] = $AnchorPath }
    Invoke-ApprovalStoreRequest @a
}
# One append for a run or claim target with a fresh control (the first verification happens in New-ApprovalTargetControl).
function Invoke-TargetAppend {
    param([string]$Store, $Target, [hashtable]$Over = @{}, [string]$Runs, [string]$Expect, [string]$AnchorPath)
    $ca = @{ Target = $Target; RunsRoot = $Runs }
    if ($PSBoundParameters.ContainsKey('Expect')) { $ca['ExpectManifestSha256'] = $Expect }
    $ctl = New-ApprovalTargetControl @ca
    $aa = @{ Store = $Store; Cand = (New-Cand $Target $Over); Resolver = $ctl.Resolver }
    if ($PSBoundParameters.ContainsKey('AnchorPath')) { $aa['AnchorPath'] = $AnchorPath }
    $res = Invoke-Append @aa
    $script:LastDiag = "outcome=$($res.Outcome) check code=$($ctl.State.LastCode)"
    [pscustomobject]@{ Res = $res; Ctl = $ctl }
}
function Get-StoreLineCount { param([string]$Store) if (Test-Path -LiteralPath $Store) { @([IO.File]::ReadAllText($Store).Split("`n") | Where-Object { $_ -ne '' }).Count } else { 0 } }
# A missing store or an empty one is a failed precondition of the case that reads it: it is reported as such (an error that the test main
# counts as a FAIL and that ends the run), never as a pass and never as a secondary file exception.
function Get-LastStoreLine {
    param([string]$Store)
    if ((Get-StoreLineCount $Store) -lt 1) { throw 'precondition failed: no approval record was stored, so the stored line cannot be checked' }
    $l = @([IO.File]::ReadAllText($Store).Split("`n") | Where-Object { $_ -ne '' })
    ConvertFrom-JsonStrict -Text $l[$l.Count - 1]
}
function New-AnchorFile {
    param([string]$Store, [string]$Dir, [string]$Name = 'anchor.txt', [string]$HashOverride = '')
    $last = Get-LastStoreLine -Store $Store
    $h = if ($HashOverride) { $HashOverride } else { [string]$last['hash'] }
    $p = Join-Path $Dir $Name
    [IO.File]::WriteAllText($p, ('{"seq":' + [string]$last['seq'] + ',"hash":"' + $h + '"}'))
    $p
}
function Get-IssueCodes { param($Res, [string]$Field) @($Res.Issues | Where-Object { $_.Field -ceq $Field } | ForEach-Object { $_.Code }) }
function Add-GateRecord {
    param([string]$Store)
    $r = Invoke-Append $Store (New-Cand (GateT))
    $r.Outcome -ceq 'stored'
}
# ---- helpers for envelope cases
function New-Env {
    param([long]$Seq, [string]$Kind, $Payload, [string]$Prev)
    $body = [ordered]@{ schemaVersion = [long]1; seq = $Seq; id = ('rec-{0:D6}' -f $Seq); kind = $Kind; prevHash = $Prev; payload = $Payload }
    $h = Get-Sha256HexOfText -Text (ConvertTo-CanonicalJson -Value $body)
    $full = [ordered]@{ hash = $h }
    foreach ($k in $body.Keys) { $full[$k] = $body[$k] }
    $full
}
function Copy-Dict { param($D) $c = [ordered]@{}; foreach ($k in $D.Keys) { $c[$k] = $D[$k] }; $c }
function Join-Env { param($Dicts) $sb = [System.Text.StringBuilder]::new(); foreach ($d in $Dicts) { [void]$sb.Append((ConvertTo-CanonicalJson -Value $d)).Append("`n") }; , $utf8.GetBytes($sb.ToString()) }
function New-SynthRepo {
    $root = New-TempDir
    $tools = Join-Path $root 'discovery/tools'
    [void][IO.Directory]::CreateDirectory($tools)
    foreach ($f in Get-ChildItem -LiteralPath $script:ToolsDir -File) { if ($f.Extension -in '.ps1', '.psm1') { Copy-Item -LiteralPath $f.FullName -Destination (Join-Path $tools $f.Name) } }
    $runs = Join-Path $root 'discovery/runs'
    [void][IO.Directory]::CreateDirectory($runs)
    [pscustomobject]@{ Root = $root; Tools = $tools; Runs = $runs; Add = (Join-Path $tools 'Add-ApprovalRecord.ps1') }
}
function Invoke-Cli {
    param($Repo, [string]$Store, [string]$Target, [string[]]$Extra = @(), [string]$Decision = 'approved', [switch]$NoActor)
    $a = @('-Approver', 'CLI Approver', '-Decision', $Decision, '-Target', $Target, '-Rationale', 'Synthetic CLI approval.', '-StorePath', $Store)
    if (-not $NoActor) { $a += @('-Actor', 'human') }
    Invoke-ChildPwsh $Repo.Add ($a + $Extra)
}

Invoke-TestMain {
    try {
        Write-Host '=== Approval target resolution (B3b): synthetic data only ===' -ForegroundColor Cyan
        $tempRoot = [IO.Path]::GetFullPath([IO.Path]::GetTempPath())

        # ------------------------------------------------------------------------------------------------ 1. identifiers
        Write-Host '--- 1. identifiers' -ForegroundColor Cyan
        foreach ($id in @($R1, 'run-20240229T235959Z-0123456789ab')) { Test-Case "Run id accepted: $id" (Test-ApprovalRunId $id) }   # +2
        $badRuns = @(
            @{ N = 'upper-case prefix'; V = 'RUN-20261201T120000Z-aaaaaaaaaaaa' }, @{ N = 'upper-case hex'; V = 'run-20261201T120000Z-AAAAAAAAAAAA' },
            @{ N = 'lower-case T'; V = 'run-20261201t120000Z-aaaaaaaaaaaa' }, @{ N = 'lower-case Z'; V = 'run-20261201T120000z-aaaaaaaaaaaa' },
            @{ N = 'trailing LF'; V = "$R1`n" }, @{ N = 'trailing CRLF'; V = "$R1`r`n" }, @{ N = 'leading space'; V = " $R1" }, @{ N = 'trailing space'; V = "$R1 " },
            @{ N = '11 hex digits'; V = 'run-20261201T120000Z-aaaaaaaaaaa' }, @{ N = '13 hex digits'; V = 'run-20261201T120000Z-aaaaaaaaaaaaa' },
            @{ N = 'non-hex digit'; V = 'run-20261201T120000Z-aaaaaaaaaaag' }, @{ N = 'month 13'; V = 'run-20261301T120000Z-aaaaaaaaaaaa' },
            @{ N = 'February 30'; V = 'run-20260230T120000Z-aaaaaaaaaaaa' }, @{ N = 'hour 25'; V = 'run-20261201T250000Z-aaaaaaaaaaaa' },
            @{ N = 'forward slash'; V = "$R1/x" }, @{ N = 'backslash'; V = "$R1\x" }, @{ N = 'parent traversal prefix'; V = "../$R1" },
            @{ N = 'double dot'; V = '..' }, @{ N = 'empty'; V = '' }, @{ N = 'null'; V = $null }, @{ N = 'integer'; V = 5 },
            @{ N = 'short form run-0001'; V = 'run-0001' }, @{ N = 'alternate data stream'; V = "${R1}:x" },
            @{ N = 'full-width digits'; V = 'run-２０２６１２０１T120000Z-aaaaaaaaaaaa' }
        )
        foreach ($c in $badRuns) { Test-Case "Run id refused: $($c.N)" (-not (Test-ApprovalRunId $c.V)) }   # +24
        foreach ($id in @('clm-0001-r1', 'clm-0002-r12', 'clm-12345-r3')) { Test-Case "Claim revision id accepted: $id" (Test-ApprovalClaimRevisionId $id) }   # +3
        $badClaims = @(
            @{ N = 'revision 0'; V = 'clm-0001-r0' }, @{ N = 'leading zero in the revision'; V = 'clm-0001-r01' }, @{ N = 'three digit counter'; V = 'clm-001-r1' },
            @{ N = 'upper case'; V = 'CLM-0001-r1' }, @{ N = 'trailing LF'; V = "clm-0001-r1`n" }, @{ N = 'no revision'; V = 'clm-0001' },
            @{ N = 'hypothesis id form'; V = 'hyp-1-r1' }, @{ N = 'slash'; V = 'clm-0001-r1/x' }, @{ N = 'traversal'; V = '../clm-0001-r1' },
            @{ N = 'empty'; V = '' }, @{ N = 'null'; V = $null }, @{ N = 'longer than 64'; V = ('clm-0001-r' + ('9' * 60)) }, @{ N = 'upper-case R'; V = 'clm-0001-R1' }
        )
        foreach ($c in $badClaims) { Test-Case "Claim revision id refused: $($c.N)" (-not (Test-ApprovalClaimRevisionId $c.V)) }   # +13

        # ------------------------------------------------------------------------------------------------ 2. record envelope
        Write-Host '--- 2. record envelope' -ForegroundColor Cyan
        $e1 = New-Env 1 'run_started' ([ordered]@{ n = [long]1 }) $G
        $e2 = New-Env 2 'error' ([ordered]@{ n = [long]2 }) $e1['hash']
        $ok2 = Read-ApprovalRunRecords -RecordsBytes (Join-Env @($e1, $e2))
        Test-Case 'envelope: two strict records are accepted' ($ok2.Ok -and $ok2.Records.Count -eq 2)   # +1
        Test-Case 'envelope: the parsed records keep their order' ($ok2.Records[0]['seq'] -eq 1 -and $ok2.Records[1]['seq'] -eq 2 -and $ok2.Records[1]['kind'] -ceq 'error')   # +1
        $empty = Read-ApprovalRunRecords -RecordsBytes ([byte[]]@())
        Test-Case 'envelope: no bytes means no records, accepted' ($empty.Ok -and $empty.Records.Count -eq 0)   # +1
        $t1 = ConvertTo-CanonicalJson -Value $e1
        $t2 = ConvertTo-CanonicalJson -Value $e2
        $mut = @(
            @{ N = 'unknown top-level key'; B = { $m = Copy-Dict $e1; $m['zextra'] = [long]1; Join-Env @($m, $e2) } },
            @{ N = 'missing payload'; B = { $m = Copy-Dict $e1; $m.Remove('payload'); Join-Env @($m, $e2) } },
            @{ N = 'kind outside the list'; B = { $m = Copy-Dict $e1; $m['kind'] = 'nope'; Join-Env @($m, $e2) } },
            @{ N = 'kind is a number'; B = { $m = Copy-Dict $e1; $m['kind'] = [long]5; Join-Env @($m, $e2) } },
            @{ N = 'schemaVersion 2'; B = { $m = Copy-Dict $e1; $m['schemaVersion'] = [long]2; Join-Env @($m, $e2) } },
            @{ N = 'schemaVersion as a string'; B = { $m = Copy-Dict $e1; $m['schemaVersion'] = '1'; Join-Env @($m, $e2) } },
            @{ N = 'seq 2 at the first position'; B = { $m = Copy-Dict $e1; $m['seq'] = [long]2; Join-Env @($m, $e2) } },
            @{ N = 'seq as a string'; B = { $m = Copy-Dict $e1; $m['seq'] = '1'; Join-Env @($m, $e2) } },
            @{ N = 'id without padding'; B = { $m = Copy-Dict $e1; $m['id'] = 'rec-1'; Join-Env @($m, $e2) } },
            @{ N = 'id of another position'; B = { $m = Copy-Dict $e1; $m['id'] = 'rec-000009'; Join-Env @($m, $e2) } },
            @{ N = 'upper-case prevHash'; B = { $m = Copy-Dict $e1; $m['prevHash'] = ('A' * 64); Join-Env @($m, $e2) } },
            @{ N = 'prevHash that is not the previous hash'; B = { $m = Copy-Dict $e2; $m['prevHash'] = ('b' * 64); Join-Env @($e1, $m) } },
            @{ N = 'short hash'; B = { $m = Copy-Dict $e1; $m['hash'] = 'abc'; Join-Env @($m, $e2) } },
            @{ N = 'missing hash'; B = { $m = Copy-Dict $e1; $m.Remove('hash'); Join-Env @($m, $e2) } },
            @{ N = 'payload is an array'; B = { $m = Copy-Dict $e1; $m['payload'] = @(1); Join-Env @($m, $e2) } },
            @{ N = 'payload is a string'; B = { $m = Copy-Dict $e1; $m['payload'] = 'x'; Join-Env @($m, $e2) } },
            @{ N = 'payload is null'; B = { $m = Copy-Dict $e1; $m['payload'] = $null; Join-Env @($m, $e2) } },
            @{ N = 'a line that is an array'; B = { , $utf8.GetBytes("[]`n") } },
            @{ N = 'an empty line between records'; B = { , $utf8.GetBytes("$t1`n`n$t2`n") } },
            @{ N = 'no final line feed'; B = { , $utf8.GetBytes("$t1`n$t2") } },
            @{ N = 'bytes that are not UTF-8'; B = { , [byte[]]($utf8.GetBytes("$t1`n") + [byte[]]@(0xC3, 0x28, 0x0A)) } },
            @{ N = 'duplicate top-level key'; B = { , $utf8.GetBytes(($t1 -replace '"hash":"([0-9a-f]{64})",', '"hash":"$1","hash":"$1",') + "`n$t2`n") } },
            @{ N = 'duplicate key inside the payload'; B = { , $utf8.GetBytes($t1.Replace('"payload":{"n":1}', '"payload":{"n":1,"n":2}') + "`n$t2`n") } },
            @{ N = 'text that is not JSON'; B = { , $utf8.GetBytes("not json`n") } }
        )
        foreach ($m in $mut) {
            $r = Read-ApprovalRunRecords -RecordsBytes (& $m.B)
            Test-Case "envelope refused: $($m.N)" (-not $r.Ok -and $r.Code -ceq 'records_invalid')
        }   # +24
        $e3 = Copy-Dict (New-Env 3 'error' ([ordered]@{ n = [long]3 }) $e2['hash']); $e3['kind'] = 'nope'
        $late = Read-ApprovalRunRecords -RecordsBytes (Join-Env @($e1, $e2, $e3))
        Test-Case 'envelope: a bad third line refuses the whole read (nothing is skipped)' (-not $late.Ok -and $late.Code -ceq 'records_invalid')   # +1

        # ------------------------------------------------------------------------------------------------ 2b. representation of RecordsBytes
        Write-Host '--- 2b. representation of VerifiedData.RecordsBytes' -ForegroundColor Cyan
        $resolverModule = Get-Module ApprovalTargetResolver
        $conv = { param($v) & $resolverModule { param($x) ConvertTo-ApprovalVerifiedBytes -Value $x } $v }
        $src = [byte[]](0, 1, 2, 10, 127, 128, 200, 255, 10)
        $cb = & $conv $src
        Test-Case 'bytes: a byte[] is used as it is (type, length, order and content)' ($cb -is [byte[]] -and $cb.Length -eq $src.Length -and [System.Linq.Enumerable]::SequenceEqual($cb, $src))   # +1
        $unrolled = if ($true) { [byte[]](0, 1, 2, 10, 127, 128, 200, 255, 10) }
        $co = & $conv $unrolled
        Test-Case 'bytes: an object[] of [byte] (the unrolled form) becomes a byte[] with the same length, order and content' ($unrolled -is [object[]] -and $co -is [byte[]] -and $co.Length -eq $src.Length -and [System.Linq.Enumerable]::SequenceEqual($co, $src))   # +1
        $one = & $conv ([byte]65)
        Test-Case 'bytes: a single [byte] (a one-byte file unrolled to a scalar) becomes a one-byte byte[]' ($one -is [byte[]] -and $one.Length -eq 1 -and $one[0] -eq 65)   # +1
        $none = & $conv $null
        Test-Case 'bytes: $null (a Run verified with zero records: empty listed records.jsonl, or none listed and none present) becomes an empty byte[]' ($none -is [byte[]] -and $none.Length -eq 0)   # +1
        $refuse = @(
            @{ N = 'an object[] with an int element'; V = [object[]]@([byte]1, [int]2) },
            @{ N = 'an object[] with a long element'; V = [object[]]@([byte]1, [long]2) },
            @{ N = 'an object[] with a string element'; V = [object[]]@([byte]1, '2') },
            @{ N = 'an object[] with a char element'; V = [object[]]@([byte]1, [char]'a') },
            @{ N = 'an object[] with a null element'; V = [object[]]@([byte]1, $null) },
            @{ N = 'an object[] with a nested array'; V = [object[]]@([byte]1, [object[]]@([byte]2)) },
            @{ N = 'an int[]'; V = [int[]](1, 2, 3) },
            @{ N = 'a string'; V = 'abc' },
            @{ N = 'an int scalar'; V = [int]5 },
            @{ N = 'a dictionary'; V = @{ a = 1 } }
        )
        foreach ($c in $refuse) { $rr = & $conv $c.V; Test-Case "bytes: $($c.N) is refused (no implicit conversion)" ($null -eq $rr) }   # +10
        $tr = New-TempDir; [void](New-SynthRun -RunsRoot $tr -RunId $R1)
        $vdr = (Test-RunDirectory -Path (Join-Path $tr $R1) -Bounded -RequireMarker -RejectReparsePoints -IncludeVerifiedData).VerifiedData
        $cv = & $conv $vdr.RecordsBytes
        $fileBytes = [IO.File]::ReadAllBytes((Join-Path (Join-Path $tr $R1) 'records.jsonl'))
        $listed = @($vdr.Manifest['artifacts'] | Where-Object { $_['path'] -ceq 'records.jsonl' })[0]['sha256']
        Test-Case 'bytes: the converted VerifiedData.RecordsBytes of a verified synthetic Run equal the file bytes and hash to the listed artifact hash' ($null -ne $vdr -and $cv -is [byte[]] -and [System.Linq.Enumerable]::SequenceEqual($cv, $fileBytes) -and (Get-Sha256Hex -Bytes $cv) -ceq $listed)   # +1

        # ------------------------------------------------------------------------------------------------ 3. check on good runs
        Write-Host '--- 3. check on good runs' -ForegroundColor Cyan
        $runs = New-TempDir
        [void](New-SynthRun -RunsRoot $runs -RunId $R1)
        [void](New-SynthRun -RunsRoot $runs -RunId $R2 -Records @(@{ Kind = 'run_started'; Payload = [ordered]@{ n = [long]1 } }, (New-HypRec 1 @((New-ClaimEntry 'clm-0005' 1)))))
        Test-Case 'layout: the runs root is a temporary directory outside the repository' ($runs.StartsWith($tempRoot) -and -not $runs.StartsWith($script:RepoRoot))   # +1
        $snapGood = Get-Snapshot $runs
        $h1 = Get-ManifestHash (Join-Path $runs $R1)
        $r = Chk (RunT $R1) $runs
        Test-Case 'run target: a completed Run verifies' ($r.Ok -and $r.Code -ceq 'ok')   # +1
        Test-Case 'run target: the result carries the manifest hash of the verified manifest' ($r.ManifestSha256 -ceq $h1)   # +1
        Test-Case 'claim target: the latest revision of a Claim resolves' ((Chk (ClaimT $R1 'clm-0001-r2') $runs).Ok)   # +1
        Test-Case 'claim target: an earlier valid revision of the same Claim resolves (no latest-only rule)' ((Chk (ClaimT $R1 'clm-0001-r1') $runs).Ok)   # +1
        Test-Case 'claim target: another Claim resolves' ((Chk (ClaimT $R1 'clm-0002-r1') $runs).Ok)   # +1
        Test-Case 'claim target: a Claim of the second Run resolves in that Run' ((Chk (ClaimT $R2 'clm-0005-r1') $runs).Ok)   # +1
        Test-Case 'expected hash: the matching hash is accepted' ((Chk (RunT $R1) $runs @{ ExpectManifestSha256 = $h1 }).Ok)   # +1
        Test-Case 'pinned hash: the matching hash is accepted' ((Chk (RunT $R1) $runs @{ PinnedManifestSha256 = $h1 }).Ok)   # +1
        Test-Case 'expected hash: another valid hash is refused (manifest_hash_mismatch)' ((Chk (RunT $R1) $runs @{ ExpectManifestSha256 = ('1' * 64) }).Code -ceq 'manifest_hash_mismatch')   # +1
        Test-Case 'pinned hash: another valid hash is refused (manifest_changed)' ((Chk (RunT $R1) $runs @{ PinnedManifestSha256 = ('1' * 64) }).Code -ceq 'manifest_changed')   # +1
        $badHashes = @(@{ N = 'empty'; V = '' }, @{ N = 'upper case'; V = ('A' * 64) }, @{ N = '63 characters'; V = ('a' * 63) }, @{ N = 'trailing LF'; V = (('a' * 64) + "`n") }, @{ N = 'not hex'; V = 'xyz' })
        foreach ($c in $badHashes) { Test-Case "expected hash refused: $($c.N)" ((Chk (RunT $R1) $runs @{ ExpectManifestSha256 = $c.V }).Code -ceq 'expected_hash_invalid') }   # +5
        Test-Case 'pinned hash refused when it is not 64 lower-case hex' ((Chk (RunT $R1) $runs @{ PinnedManifestSha256 = 'zz' }).Code -ceq 'expected_hash_invalid')   # +1
        Test-Case 'claim target: a Claim that is not in the Run is refused (claim_not_found)' ((Chk (ClaimT $R1 'clm-0003-r1') $runs).Code -ceq 'claim_not_found')   # +1
        Test-Case 'claim target: a revision that does not exist is refused (claim_not_found)' ((Chk (ClaimT $R1 'clm-0001-r3') $runs).Code -ceq 'claim_not_found')   # +1
        Test-Case 'claim target: a Claim of another Run is not found in this Run' ((Chk (ClaimT $R1 'clm-0005-r1') $runs).Code -ceq 'claim_not_found')   # +1
        Test-Case 'claim target: a Claim of this Run is not found in the other Run' ((Chk (ClaimT $R2 'clm-0001-r1') $runs).Code -ceq 'claim_not_found')   # +1
        $shapes = @(
            @{ N = 'run with an extra key'; T = ([ordered]@{ kind = 'run'; run_id = $R1; gate_id = 'm6-start' }) },
            @{ N = 'run without run_id'; T = ([ordered]@{ kind = 'run' }) },
            @{ N = 'claim without claim_revision_id'; T = ([ordered]@{ kind = 'claim_revision'; run_id = $R1 }) },
            @{ N = 'claim with an extra key'; T = ([ordered]@{ kind = 'claim_revision'; run_id = $R1; claim_revision_id = 'clm-0001-r1'; x = 'y' }) },
            @{ N = 'a string'; T = "run:$R1" },
            @{ N = 'kind gate'; T = (GateT) },
            @{ N = 'unknown kind'; T = ([ordered]@{ kind = 'other'; run_id = $R1 }) }
        )
        foreach ($c in $shapes) { Test-Case "target shape refused: $($c.N)" ((Chk $c.T $runs).Code -ceq 'target_invalid') }   # +7
        $idForms = @("$R1`n", "$R1`r`n", $R1.ToUpperInvariant(), "${R1}x", 'run-0001', "$R1/")
        foreach ($v in $idForms) { Test-Case "Run id form refused before any file access: $($v.Replace("`n", '\n').Replace("`r", '\r'))" ((Chk (RunT $v) $runs).Code -ceq 'run_id_invalid') }   # +6
        Test-Case 'Run id with traversal does not reach the Run behind it (run_id_invalid, not a verification)' ((Chk (RunT "../$R1") (Join-Path $runs 'no-such-subdirectory')).Code -ceq 'run_id_invalid')   # +1
        foreach ($v in @('clm-0001-r0', "clm-0001-r1`n", 'CLM-0001-R1')) { Test-Case "Claim id form refused: $($v.Replace("`n", '\n'))" ((Chk (ClaimT $R1 $v) $runs).Code -ceq 'claim_id_invalid') }   # +3
        Test-Case 'the good Runs are byte-, list- and time-identical after the checks of this section' ((Get-Snapshot $runs) -ceq $snapGood)   # +1

        # ------------------------------------------------------------------------------------------------ 4. Runs that do not verify
        Write-Host '--- 4. Runs that do not verify' -ForegroundColor Cyan
        $bad = New-TempDir
        $idMissing = Get-Bid 1
        Test-Case 'missing Run is refused (run_not_verified)' ((Chk (RunT $idMissing) $bad).Code -ceq 'run_not_verified')   # +1
        $id = Get-Bid 2; [void](New-SynthRun -RunsRoot $bad -RunId $id -NoComplete)
        Test-Case 'a Run without COMPLETE is refused (run_not_verified)' ((Chk (RunT $id) $bad).Code -ceq 'run_not_verified')   # +1
        $id = Get-Bid 3; [void](New-SynthRun -RunsRoot $bad -RunId $id -CompleteText ('0' * 64))
        Test-Case 'COMPLETE that is not the manifest hash is refused (verified_data_missing)' ((Chk (RunT $id) $bad).Code -ceq 'verified_data_missing')   # +1
        $id = Get-Bid 4; $d = New-SynthRun -RunsRoot $bad -RunId $id; [IO.File]::WriteAllText((Join-Path $d 'COMPLETE'), ((Get-ManifestHash $d) + "`n"))
        Test-Case 'COMPLETE with a final line feed is accepted (existing marker rule)' ((Chk (RunT $id) $bad).Ok)   # +1
        $id = Get-Bid 5; $d = New-SynthRun -RunsRoot $bad -RunId $id; [IO.File]::WriteAllText((Join-Path $d 'COMPLETE'), ((Get-ManifestHash $d) + (' ' * 200)))
        Test-Case 'COMPLETE above the 128 byte bound is refused (the bounded reader failure becomes a refusal)' ((Chk (RunT $id) $bad).Code -ceq 'run_not_verified')   # +1
        $id = Get-Bid 6; $d = New-SynthRun -RunsRoot $bad -RunId $id; [IO.File]::AppendAllText((Join-Path $d 'records.jsonl'), "`n")
        Test-Case 'records.jsonl changed after sealing (artifact hash) is refused' ((Chk (RunT $id) $bad).Code -ceq 'run_not_verified')   # +1
        $id = Get-Bid 7; $d = New-SynthRun -RunsRoot $bad -RunId $id
        $rp = Join-Path $d 'records.jsonl'; $tampered = ([IO.File]::ReadAllText($rp)).Replace('"n":1', '"n":9'); [IO.File]::WriteAllText($rp, $tampered)
        Update-SynthManifest -Dir $d -Over @{ artifacts = @([ordered]@{ path = 'records.jsonl'; sha256 = (Get-Sha256HexOfFile -Path $rp) }) }
        Test-Case 'a record edited with a matching artifact hash is a chain break and is refused' ((Chk (RunT $id) $bad).Code -ceq 'run_not_verified')   # +1
        $id = Get-Bid 8; $d = New-SynthRun -RunsRoot $bad -RunId $id; [IO.File]::WriteAllText((Join-Path $d 'extra.txt'), 'x')
        Test-Case 'an unlisted file in the Run is refused' ((Chk (RunT $id) $bad).Code -ceq 'run_not_verified')   # +1
        $id = Get-Bid 9; $d = New-SynthRun -RunsRoot $bad -RunId $id
        Update-SynthManifest -Dir $d -Over @{ artifacts = @([ordered]@{ path = 'records.jsonl'; sha256 = (Get-Sha256HexOfFile -Path (Join-Path $d 'records.jsonl')) }, [ordered]@{ path = ('blobs/' + ('c' * 64)); sha256 = ('c' * 64) }) }
        Test-Case 'a listed artifact that is missing is refused' ((Chk (RunT $id) $bad).Code -ceq 'run_not_verified')   # +1
        $id = Get-Bid 10; [void](New-SynthRun -RunsRoot $bad -RunId $id -ManifestOver @{ runId = $R2 })
        Test-Case 'manifest.runId of another Run is refused (manifest_run_id_mismatch)' ((Chk (RunT $id) $bad).Code -ceq 'manifest_run_id_mismatch')   # +1
        $id = Get-Bid 11; [void](New-SynthRun -RunsRoot $bad -RunId $id -ManifestOver @{ runId = $null })
        Test-Case 'a manifest without runId is refused (manifest_run_id_mismatch)' ((Chk (RunT $id) $bad).Code -ceq 'manifest_run_id_mismatch')   # +1
        $id = Get-Bid 12; [void](New-SynthRun -RunsRoot $bad -RunId $id -ManifestOver @{ runId = $id.ToUpperInvariant() })
        Test-Case 'manifest.runId that differs in case is refused (manifest_run_id_mismatch)' ((Chk (RunT $id) $bad).Code -ceq 'manifest_run_id_mismatch')   # +1
        $id = Get-Bid 13; $d = New-SynthRun -RunsRoot $bad -RunId $id; [IO.File]::WriteAllText((Join-Path $d 'manifest.json'), 'garbage'); [IO.File]::WriteAllText((Join-Path $d 'COMPLETE'), (Get-ManifestHash $d))
        Test-Case 'a manifest that is not JSON is refused' ((Chk (RunT $id) $bad).Code -ceq 'run_not_verified')   # +1
        $id = Get-Bid 14; $d = New-SynthRun -RunsRoot $bad -RunId $id
        $linkTarget = Join-Path (New-TempDir) 'target'; [void][IO.Directory]::CreateDirectory($linkTarget)
        New-Link -Path (Join-Path $d 'linked') -Target $linkTarget
        Test-Case 'a junction inside the Run is refused (links are rejected)' ((Chk (RunT $id) $bad).Code -ceq 'run_not_verified')   # +1
        $realRoot = New-TempDir; [void](New-SynthRun -RunsRoot $realRoot -RunId $R1)
        $id = Get-Bid 15
        New-Link -Path (Join-Path $bad $id) -Target (Join-Path $realRoot $R1)
        Test-Case 'a Run directory that is itself a junction is refused' ((Chk (RunT $id) $bad).Code -ceq 'run_not_verified')   # +1
        $dupLine = { param($Dir) $p = Join-Path $Dir 'records.jsonl'; $t = [IO.File]::ReadAllText($p); $t2 = $t -replace '"hash":"([0-9a-f]{64})",', '"hash":"$1","hash":"$1",'; [IO.File]::WriteAllText($p, $t2); Update-SynthManifest -Dir $Dir -Over @{ artifacts = @([ordered]@{ path = 'records.jsonl'; sha256 = (Get-Sha256HexOfFile -Path $p) }) } }
        $id = Get-Bid 16; $d = New-SynthRun -RunsRoot $bad -RunId $id; & $dupLine $d
        Test-Case 'a record with a duplicate key is refused' ((Chk (RunT $id) $bad).Code -ceq 'run_not_verified')   # +1
        # a record that the chain accepts but that is not a strict envelope
        $envBad = @(
            @{ N = 'unknown top-level key'; R = @{ Kind = 'error'; Payload = [ordered]@{ n = [long]3 }; Extra = [ordered]@{ zextra = [long]1 } } },
            @{ N = 'kind outside the list'; R = @{ Kind = 'nope'; Payload = [ordered]@{ n = [long]3 } } },
            @{ N = 'payload that is an array'; R = @{ Kind = 'error'; Payload = @(1, 2) } },
            @{ N = 'schemaVersion 2'; R = @{ Kind = 'error'; Payload = [ordered]@{ n = [long]3 }; Extra = [ordered]@{ schemaVersion = [long]2 } } }
        )
        $n = 20
        foreach ($c in $envBad) {
            $n++; $id = Get-Bid $n
            [void](New-SynthRun -RunsRoot $bad -RunId $id -Records (@(Get-StdRecords) + @($c.R)))
            Test-Case "envelope in a verified Run, run target: $($c.N) is refused (records_invalid)" ((Chk (RunT $id) $bad).Code -ceq 'records_invalid')
        }   # +4
        $id = Get-Bid 30
        [void](New-SynthRun -RunsRoot $bad -RunId $id -Records (@(Get-StdRecords) + @(@{ Kind = 'error'; Payload = [ordered]@{ n = [long]3 }; Extra = [ordered]@{ zextra = [long]1 } })))
        Test-Case 'envelope in a verified Run, claim target: an unknown key is refused (records_invalid)' ((Chk (ClaimT $id 'clm-0001-r1') $bad).Code -ceq 'records_invalid')   # +1

        # ------------------------------------------------------------------------------------------------ 5. Claim structure
        Write-Host '--- 5. Claim structure' -ForegroundColor Cyan
        $claimBad = New-TempDir
        $mutClaims = @(
            @{ N = 'missing semanticSha256'; O = @{ semanticSha256 = $REMOVE } }, @{ N = 'semanticSha256 that is not a hash'; O = @{ semanticSha256 = 'xyz' } },
            @{ N = 'revision 0'; O = @{ revision = [long]0; claimRevisionId = 'clm-0007-r0' } }, @{ N = 'revision as a string'; O = @{ revision = '1' } },
            @{ N = 'claimRevisionId that does not follow claimId and revision'; O = @{ claimRevisionId = 'clm-0007-r2' } },
            @{ N = 'upper-case claimId'; O = @{ claimId = 'CLM-0007'; claimRevisionId = 'CLM-0007-r1' } }, @{ N = 'unknown key'; O = @{ zzz = 'y' } },
            @{ N = 'origin human-authored'; O = @{ origin = 'human-authored' } },
            @{ N = 'confidence outside low, medium, high'; O = @{ aiStated = [ordered]@{ confidence = 'extreme'; openQuestions = @('q') } } },
            @{ N = 'openQuestions that is a string'; O = @{ aiStated = [ordered]@{ confidence = 'low'; openQuestions = 'q' } } },
            @{ N = 'openQuestions with a number'; O = @{ aiStated = [ordered]@{ confidence = 'low'; openQuestions = @([long]1) } } },
            @{ N = 'claim that is a string'; O = @{ claim = 'text' } }, @{ N = 'predecessorRevision not below revision'; O = @{ predecessorRevision = [long]1 } },
            @{ N = 'missing aiStated'; O = @{ aiStated = $REMOVE } }, @{ N = 'aiStated with an extra key'; O = @{ aiStated = [ordered]@{ confidence = 'low'; openQuestions = @(); extra = 'x' } } }
        )
        $n = 40
        foreach ($c in $mutClaims) {
            $n++; $id = Get-Bid $n
            $recs = @(Get-StdRecords) + @((New-HypRec 3 @((New-ClaimEntry 'clm-0007' 1 $c.O))))
            [void](New-SynthRun -RunsRoot $claimBad -RunId $id -Records $recs)
            Test-Case "claim entry refused in a related record: $($c.N) (the valid Claim in another record is refused too)" ((Chk (ClaimT $id 'clm-0002-r1') $claimBad).Code -ceq 'claim_record_invalid')
        }   # +15
        $id = Get-Bid 60; [void](New-SynthRun -RunsRoot $claimBad -RunId $id -Records (@(Get-StdRecords) + @(@{ Kind = 'hypothesis_revision'; Payload = [ordered]@{ hypothesisId = 'hyp-3'; revision = [long]3; claims = @() } })))
        Test-Case 'a hypothesis_revision with an empty claims list is refused' ((Chk (ClaimT $id 'clm-0002-r1') $claimBad).Code -ceq 'claim_record_invalid')   # +1
        $id = Get-Bid 61; [void](New-SynthRun -RunsRoot $claimBad -RunId $id -Records (@(Get-StdRecords) + @(@{ Kind = 'hypothesis_revision'; Payload = [ordered]@{ hypothesisId = 'hyp-3'; revision = [long]3 } })))
        Test-Case 'a hypothesis_revision without claims is refused' ((Chk (ClaimT $id 'clm-0002-r1') $claimBad).Code -ceq 'claim_record_invalid')   # +1
        $id = Get-Bid 62; [void](New-SynthRun -RunsRoot $claimBad -RunId $id -Records (@(Get-StdRecords) + @(@{ Kind = 'hypothesis_revision'; Payload = [ordered]@{ hypothesisId = 'hyp-3'; revision = [long]3; claims = 'text' } })))
        Test-Case 'a hypothesis_revision whose claims is not a list is refused' ((Chk (ClaimT $id 'clm-0002-r1') $claimBad).Code -ceq 'claim_record_invalid')   # +1
        $many = 1..51 | ForEach-Object { New-ClaimEntry ('clm-' + (200 + $_).ToString('0000')) 1 }
        $id = Get-Bid 63; [void](New-SynthRun -RunsRoot $claimBad -RunId $id -Records (@(Get-StdRecords) + @((New-HypRec 3 $many))))
        Test-Case 'a hypothesis_revision with more than 50 claims is refused' ((Chk (ClaimT $id 'clm-0002-r1') $claimBad).Code -ceq 'claim_record_invalid')   # +1
        $id = Get-Bid 64; [void](New-SynthRun -RunsRoot $claimBad -RunId $id -Records (@(Get-StdRecords) + @((New-HypRec 3 @((New-ClaimEntry 'clm-0001' 1))))))
        Test-Case 'a revision id that occurs in two records is ambiguous (target is the duplicate)' ((Chk (ClaimT $id 'clm-0001-r1') $claimBad).Code -ceq 'claim_ambiguous')   # +1
        Test-Case 'a revision id that occurs in two records makes the Run ambiguous for another Claim too' ((Chk (ClaimT $id 'clm-0002-r1') $claimBad).Code -ceq 'claim_ambiguous')   # +1
        $id = Get-Bid 65; [void](New-SynthRun -RunsRoot $claimBad -RunId $id -Records (@(Get-StdRecords) + @((New-HypRec 3 @((New-ClaimEntry 'clm-0009' 1), (New-ClaimEntry 'clm-0009' 1))))))
        Test-Case 'a revision id twice in one record is ambiguous' ((Chk (ClaimT $id 'clm-0009-r1') $claimBad).Code -ceq 'claim_ambiguous')   # +1
        $id = Get-Bid 66; [void](New-SynthRun -RunsRoot $claimBad -RunId $id -Records (@(Get-StdRecords) + @(@{ Kind = 'error'; Payload = [ordered]@{ claims = 'not a claims list' } })))
        Test-Case 'a claims member in a record of another kind is not read as a Claim list' ((Chk (ClaimT $id 'clm-0002-r1') $claimBad).Ok)   # +1

        # ------------------------------------------------------------------------------------------------ 6. appends in process
        Write-Host '--- 6. appends in process' -ForegroundColor Cyan
        $st = New-StorePath
        $a = Invoke-TargetAppend -Store $st -Target (RunT $R1) -Runs $runs
        Test-Case 'run approval is stored' ($a.Res.Outcome -ceq 'stored' -and (Get-StoreLineCount $st) -eq 1)   # +1
        Test-Case 'two independent verifications and one resolver call; the pinned hash is the manifest hash' ($a.Ctl.State.Verifications -eq 2 -and $a.Ctl.State.ResolverCalls -eq 1 -and $a.Ctl.State.LastCode -ceq 'ok' -and $a.Ctl.State.PinnedManifestSha256 -ceq $h1)   # +1
        $line = Get-LastStoreLine $st
        $approvalKeys = @('type', 'seq', 'prev_hash', 'approver', 'timestamp', 'target', 'decision', 'rationale', 'recorded_by', 'hash')
        Test-Case 'the stored line has the existing schema, the run target, and no manifest hash' (@($line.Keys).Count -eq 10 -and (@($line.Keys | Where-Object { $approvalKeys -cnotcontains $_ }).Count -eq 0) -and $line['target']['kind'] -ceq 'run' -and $line['target']['run_id'] -ceq $R1 -and -not ([IO.File]::ReadAllText($st)).Contains($h1))   # +1
        $b = Invoke-TargetAppend -Store $st -Target (ClaimT $R1 'clm-0001-r2') -Runs $runs
        Test-Case 'claim approval (latest revision) is stored' ($b.Res.Outcome -ceq 'stored' -and (Get-StoreLineCount $st) -eq 2)   # +1
        $c = Invoke-TargetAppend -Store $st -Target (ClaimT $R1 'clm-0001-r1') -Runs $runs
        Test-Case 'claim approval (earlier valid revision) is stored' ($c.Res.Outcome -ceq 'stored' -and (Get-StoreLineCount $st) -eq 3)   # +1
        Test-Case 'the stored claim target has the form of the existing schema' ((Get-LastStoreLine $st)['target']['kind'] -ceq 'claim_revision' -and (Get-LastStoreLine $st)['target']['claim_revision_id'] -ceq 'clm-0001-r1')   # +1
        $d1 = Invoke-TargetAppend -Store $st -Target (ClaimT $R1 'clm-0001-r1') -Runs $runs -Over @{ decision = 'rejected'; supersedes = [long]3 }
        $an = Get-ApprovalStoreAnalysis -Bytes ([IO.File]::ReadAllBytes($st))
        Test-Case 'supersedes of the same claim target is stored; the chain verifies and record 3 is superseded' ($d1.Res.Outcome -ceq 'stored' -and $an.Ok -and $an.SupersededBy.ContainsKey([long]3))   # +1
        Test-Case 'the latest seq decides: seq 4 (rejected) is the last record for the target' ((Get-LastStoreLine $st)['seq'] -eq 4 -and (Get-LastStoreLine $st)['decision'] -ceq 'rejected' -and (Get-LastStoreLine $st)['supersedes'] -eq 3)   # +1
        $before = [IO.File]::ReadAllBytes($st)
        $d2 = Invoke-TargetAppend -Store $st -Target (ClaimT $R1 'clm-0001-r1') -Runs $runs -Over @{ supersedes = [long]3 }
        Test-Case 'a record that is already superseded cannot be superseded again' ($d2.Res.Outcome -ceq 'invalid' -and (Get-IssueCodes $d2.Res 'supersedes') -ccontains 'supersedes_already_superseded' -and (Test-BytesEqual $before ([IO.File]::ReadAllBytes($st))))   # +1
        $d3 = Invoke-TargetAppend -Store $st -Target (ClaimT $R1 'clm-0002-r1') -Runs $runs -Over @{ supersedes = [long]3 }
        Test-Case 'supersedes of a record with another target is refused' ($d3.Res.Outcome -ceq 'invalid' -and (Get-IssueCodes $d3.Res 'supersedes') -ccontains 'supersedes_target_differs' -and (Test-BytesEqual $before ([IO.File]::ReadAllBytes($st))))   # +1
        $d4 = Invoke-TargetAppend -Store $st -Target (RunT $R1) -Runs $runs -Over @{ supersedes = [long]99 }
        Test-Case 'supersedes of an unknown record is refused' ($d4.Res.Outcome -ceq 'invalid' -and (Get-IssueCodes $d4.Res 'supersedes') -ccontains 'supersedes_unknown' -and (Test-BytesEqual $before ([IO.File]::ReadAllBytes($st))))   # +1
        $d5 = Invoke-TargetAppend -Store $st -Target (RunT $R1) -Runs $runs -Over @{ recorded_by = 'somebody' }
        Test-Case 'an actor outside the two declared values is refused and the store is unchanged' ($d5.Res.Outcome -ceq 'invalid' -and (Get-IssueCodes $d5.Res 'recorded_by') -ccontains 'bad_value' -and (Test-BytesEqual $before ([IO.File]::ReadAllBytes($st))))   # +1
        $d6 = Invoke-TargetAppend -Store $st -Target (RunT $R1) -Runs $runs -Over @{ recorded_by = $null }
        Test-Case 'a missing actor is refused and the store is unchanged' ($d6.Res.Outcome -ceq 'invalid' -and (Get-IssueCodes $d6.Res 'recorded_by') -ccontains 'missing_field' -and (Test-BytesEqual $before ([IO.File]::ReadAllBytes($st))))   # +1
        # the target is refused: the existing code, the store unchanged, no write
        $x1 = Invoke-TargetAppend -Store $st -Target (ClaimT $R1 'clm-0003-r1') -Runs $runs
        Test-Case 'a claim that is not in the Run: unresolved_target, store unchanged' ($x1.Res.Outcome -ceq 'invalid' -and (Get-IssueCodes $x1.Res 'target') -ccontains 'unresolved_target' -and $x1.Ctl.State.LastCode -ceq 'claim_not_found' -and (Test-BytesEqual $before ([IO.File]::ReadAllBytes($st))))   # +1
        # gate approvals do not depend on Runs
        $stG = New-StorePath
        Test-Case 'gate approval without any resolver is stored as before' (Add-GateRecord $stG)   # +1
        $script:GateCalls = 0
        $gRes = Invoke-Append $stG (New-Cand (GateT)) { param($t) $script:GateCalls++; $false }
        Test-Case 'gate approval with a resolver that refuses everything is stored and the resolver is never called' ($gRes.Outcome -ceq 'stored' -and $script:GateCalls -eq 0)   # +1
        $sg2 = New-StorePath
        $badCtl = New-ApprovalTargetControl -Target (RunT (Get-Bid 90)) -RunsRoot $bad
        $sx = Invoke-Append $sg2 (New-Cand (RunT (Get-Bid 90))) $badCtl.Resolver
        Test-Case 'a refused run target writes nothing and does not create the store file' ($sx.Outcome -ceq 'invalid' -and -not (Test-Path -LiteralPath $sg2))   # +1
        Test-Case 'a gate approval is still stored after a refused run target in the same store' ((Add-GateRecord $sg2) -and (Get-StoreLineCount $sg2) -eq 1)   # +1

        # expected hash
        $stE = New-StorePath
        $e = Invoke-TargetAppend -Store $stE -Target (RunT $R1) -Runs $runs -Expect $h1
        Test-Case 'ExpectManifestSha256 that matches: stored; both verifications saw the hash' ($e.Res.Outcome -ceq 'stored' -and $e.Ctl.State.Verifications -eq 2)   # +1
        $bytesE = [IO.File]::ReadAllBytes($stE)
        $e2r = Invoke-TargetAppend -Store $stE -Target (RunT $R1) -Runs $runs -Expect ('2' * 64)
        Test-Case 'ExpectManifestSha256 that does not match: refused at the first verification, no second verification, store unchanged' ($e2r.Res.Outcome -ceq 'invalid' -and $e2r.Ctl.State.LastCode -ceq 'manifest_hash_mismatch' -and $e2r.Ctl.State.Verifications -eq 1 -and (Test-BytesEqual $bytesE ([IO.File]::ReadAllBytes($stE))))   # +1

        # anchor combinations
        $anchorDir = New-TempDir
        $anchor = New-AnchorFile -Store $stE -Dir $anchorDir
        $anchorSnap = (Get-FileHash -LiteralPath $anchor).Hash + '|' + (Get-Item -LiteralPath $anchor).LastWriteTimeUtc.Ticks
        $an1 = Invoke-TargetAppend -Store $stE -Target (ClaimT $R1 'clm-0002-r1') -Runs $runs -AnchorPath $anchor
        Test-Case 'a valid anchor with a claim target: stored, two verifications' ($an1.Res.Outcome -ceq 'stored' -and $an1.Ctl.State.Verifications -eq 2)   # +1
        $bytesA = [IO.File]::ReadAllBytes($stE)
        $anBad = New-AnchorFile -Store $stE -Dir $anchorDir -Name 'wrong.txt' -HashOverride ('9' * 64)
        $an2 = Invoke-TargetAppend -Store $stE -Target (RunT $R1) -Runs $runs -AnchorPath $anBad
        Test-Case 'an anchor whose hash differs: the store is not extended, the resolver is not reached' ($an2.Res.Outcome -ceq 'store_invalid' -and $an2.Ctl.State.ResolverCalls -eq 0 -and (Test-BytesEqual $bytesA ([IO.File]::ReadAllBytes($stE))))   # +1
        $an3 = Invoke-TargetAppend -Store $stE -Target (RunT $R1) -Runs $runs -AnchorPath (Join-Path $anchorDir 'missing.txt')
        Test-Case 'an anchor that is missing: anchor_rejected, no write, the resolver is not reached' ($an3.Res.Outcome -ceq 'anchor_rejected' -and $an3.Ctl.State.ResolverCalls -eq 0 -and (Test-BytesEqual $bytesA ([IO.File]::ReadAllBytes($stE))))   # +1
        Test-Case 'the anchor file is unchanged by all of this' (((Get-FileHash -LiteralPath $anchor).Hash + '|' + (Get-Item -LiteralPath $anchor).LastWriteTimeUtc.Ticks) -ceq $anchorSnap)   # +1
        Test-Case 'the good Runs are still byte-, list- and time-identical after all appends' ((Get-Snapshot $runs) -ceq $snapGood)   # +1

        # ------------------------------------------------------------------------------------------------ 7. second verification under the mutex
        Write-Host '--- 7. second verification under the mutex' -ForegroundColor Cyan
        $rv = New-TempDir
        $stR = New-StorePath
        [void](Add-GateRecord $stR)
        $bytesR = [IO.File]::ReadAllBytes($stR)
        $okCtl = New-ApprovalTargetControl -Target (RunT $R1) -RunsRoot $runs
        $one = @(& $okCtl.Resolver (RunT $R1))
        Test-Case 'the resolver returns exactly one boolean (true) for a Run that still verifies' ($one.Count -eq 1 -and $one[0] -is [bool] -and $one[0] -eq $true)   # +1
        $other = @(& $okCtl.Resolver (RunT $R2))
        Test-Case 'the resolver refuses a target other than the one of the first verification (target_mismatch, no verification)' ($other.Count -eq 1 -and $other[0] -eq $false -and $okCtl.State.LastCode -ceq 'target_mismatch' -and $okCtl.State.Verifications -eq 2)   # +1
        $v1 = Get-Bid 70; $dv = New-SynthRun -RunsRoot $rv -RunId $v1
        $ctl = New-ApprovalTargetControl -Target (RunT $v1) -RunsRoot $rv
        Remove-Item -LiteralPath $dv -Recurse -Force
        $res = Invoke-Append $stR (New-Cand (RunT $v1)) $ctl.Resolver
        Test-Case 'the Run is deleted after the first verification: refused, run_not_verified, store unchanged' ($res.Outcome -ceq 'invalid' -and (Get-IssueCodes $res 'target') -ccontains 'unresolved_target' -and $ctl.State.LastCode -ceq 'run_not_verified' -and $ctl.State.Verifications -eq 2 -and (Test-BytesEqual $bytesR ([IO.File]::ReadAllBytes($stR))))   # +1
        $v2 = Get-Bid 71; $dv = New-SynthRun -RunsRoot $rv -RunId $v2
        $ctl = New-ApprovalTargetControl -Target (ClaimT $v2 'clm-0001-r1') -RunsRoot $rv
        [IO.File]::AppendAllText((Join-Path $dv 'records.jsonl'), 'x')
        $res = Invoke-Append $stR (New-Cand (ClaimT $v2 'clm-0001-r1')) $ctl.Resolver
        Test-Case 'the Run is corrupted after the first verification: refused, run_not_verified, store unchanged' ($res.Outcome -ceq 'invalid' -and $ctl.State.LastCode -ceq 'run_not_verified' -and (Test-BytesEqual $bytesR ([IO.File]::ReadAllBytes($stR))))   # +1
        $v3 = Get-Bid 72; $dv = New-SynthRun -RunsRoot $rv -RunId $v3
        $ctl = New-ApprovalTargetControl -Target (RunT $v3) -RunsRoot $rv
        Update-SynthManifest -Dir $dv -Over @{ note = 'another valid manifest' }
        Test-Case 'the replacement Run is itself a valid completed Run (the check passes without the pinned hash)' ((Chk (RunT $v3) $rv).Ok)   # +1
        $res = Invoke-Append $stR (New-Cand (RunT $v3)) $ctl.Resolver
        Test-Case 'the manifest is replaced by another valid manifest of the same Run id: refused, manifest_changed, store unchanged' ($res.Outcome -ceq 'invalid' -and $ctl.State.LastCode -ceq 'manifest_changed' -and (Test-BytesEqual $bytesR ([IO.File]::ReadAllBytes($stR))))   # +1
        $v4 = Get-Bid 73; $dv = New-SynthRun -RunsRoot $rv -RunId $v4
        $ctl = New-ApprovalTargetControl -Target (ClaimT $v4 'clm-0002-r1') -RunsRoot $rv
        Remove-Item -LiteralPath $dv -Recurse -Force
        [void](New-SynthRun -RunsRoot $rv -RunId $v4 -Records @(@{ Kind = 'run_started'; Payload = [ordered]@{ n = [long]7 } }, (New-HypRec 1 @((New-ClaimEntry 'clm-0002' 1)))))
        Test-Case 'the Run is replaced by a different valid Run with the same id: refused, manifest_changed' ((Chk (ClaimT $v4 'clm-0002-r1') $rv).Ok -and ($res = Invoke-Append $stR (New-Cand (ClaimT $v4 'clm-0002-r1')) $ctl.Resolver) -and $res.Outcome -ceq 'invalid' -and $ctl.State.LastCode -ceq 'manifest_changed' -and (Test-BytesEqual $bytesR ([IO.File]::ReadAllBytes($stR))))   # +1
        $v5 = Get-Bid 74
        $ctl = New-ApprovalTargetControl -Target (RunT $v5) -RunsRoot $rv
        [void](New-SynthRun -RunsRoot $rv -RunId $v5)
        $res = Invoke-Append $stR (New-Cand (RunT $v5)) $ctl.Resolver
        Test-Case 'a Run that did not verify at the first check is refused even if it exists when the store calls (no second verification, no append)' ($res.Outcome -ceq 'invalid' -and $ctl.State.Verifications -eq 1 -and $ctl.State.LastCode -ceq 'run_not_verified' -and (Test-BytesEqual $bytesR ([IO.File]::ReadAllBytes($stR))))   # +1
        # the store changes after the resolver and before the write
        $v6 = Get-Bid 75; [void](New-SynthRun -RunsRoot $rv -RunId $v6)
        $ctl = New-ApprovalTargetControl -Target (RunT $v6) -RunsRoot $rv
        $inner = $ctl.Resolver
        $wrap = { param($t) $ok = & $inner $t; [IO.File]::AppendAllText($stR, ' '); $ok }.GetNewClosure()
        $res = Invoke-Append $stR (New-Cand (RunT $v6)) $wrap
        $expected = [byte[]]($bytesR + [byte[]]@(0x20))
        Test-Case 'the store is modified after the second verification and before the write: store_changed, nothing is appended' ($res.Outcome -ceq 'store_changed' -and $res.Reason -ceq 'store_modified' -and (Test-BytesEqual $expected ([IO.File]::ReadAllBytes($stR))))   # +1
        Test-Case 'the second verification took place before the final store comparison (it ran, and the append was refused after it)' ($ctl.State.Verifications -eq 2 -and $ctl.State.LastCode -ceq 'ok')   # +1
        [IO.File]::WriteAllBytes($stR, $bytesR)
        $ctl = New-ApprovalTargetControl -Target (RunT $v6) -RunsRoot $rv
        $res = Invoke-Append $stR (New-Cand (RunT $v6)) $ctl.Resolver
        Test-Case 'the same Run is appended only when the second verification also succeeds' ($res.Outcome -ceq 'stored' -and $ctl.State.Verifications -eq 2 -and (Get-StoreLineCount $stR) -eq 2)   # +1

        # ------------------------------------------------------------------------------------------------ 8. command line, synthetic repository
        Write-Host '--- 8. command line (a copy of the tools in a temporary repository)' -ForegroundColor Cyan
        $repo = New-SynthRepo
        Test-Case 'layout: the synthetic repository is a temporary directory outside the repository' ($repo.Root.StartsWith($tempRoot) -and -not $repo.Root.StartsWith($script:RepoRoot) -and -not (Test-Path -LiteralPath (Join-Path $repo.Root 'discovery/approvals')))   # +1
        $cs = New-StorePath
        $o = Invoke-Cli $repo $cs 'gate:m6-start'
        Test-Case 'cli: a gate approval works with no runs directory content at all' ($o.ExitCode -eq 0 -and (Get-StoreLineCount $cs) -eq 1)   # +1
        [void](New-SynthRun -RunsRoot $repo.Runs -RunId $R1)
        [void](New-SynthRun -RunsRoot $repo.Runs -RunId $R2 -Records @(@{ Kind = 'run_started'; Payload = [ordered]@{ n = [long]1 } }, (New-HypRec 1 @((New-ClaimEntry 'clm-0005' 1)))))
        $hc = Get-ManifestHash (Join-Path $repo.Runs $R1)
        $repoSnap = Get-Snapshot $repo.Runs
        $o = Invoke-Cli $repo $cs "run:$R1"
        Test-Case 'cli: a run approval is stored (exit 0)' ($o.ExitCode -eq 0 -and (Get-StoreLineCount $cs) -eq 2 -and $o.Output -match 'stored seq 2')   # +1
        $o = Invoke-Cli $repo $cs "claim:$R1/clm-0001-r1"
        Test-Case 'cli: a claim approval of an earlier revision is stored (exit 0)' ($o.ExitCode -eq 0 -and (Get-StoreLineCount $cs) -eq 3)   # +1
        $o = Invoke-Cli $repo $cs "claim:$R2/clm-0005-r1" -Extra @('-ExpectManifestSha256', (Get-ManifestHash (Join-Path $repo.Runs $R2)))
        Test-Case 'cli: -ExpectManifestSha256 that matches is accepted' ($o.ExitCode -eq 0 -and (Get-StoreLineCount $cs) -eq 4)   # +1
        $cb = [IO.File]::ReadAllBytes($cs)
        $o = Invoke-Cli $repo $cs "run:$R1" -Extra @('-ExpectManifestSha256', ('3' * 64))
        Test-Case 'cli: -ExpectManifestSha256 that does not match is refused with the fixed code, store unchanged' ($o.ExitCode -eq 1 -and $o.Error -match 'invalid field: target \(unresolved_target\)' -and $o.Error -match 'target_check: manifest_hash_mismatch' -and (Test-BytesEqual $cb ([IO.File]::ReadAllBytes($cs))))   # +1
        $badFormats = @(@{ N = 'empty'; V = '' }, @{ N = 'upper case'; V = ('A' * 64) }, @{ N = '63 characters'; V = ('a' * 63) }, @{ N = 'trailing LF'; V = ($hc + "`n") }, @{ N = 'not hex'; V = 'zz' })
        foreach ($f in $badFormats) {
            $o = Invoke-Cli $repo $cs "run:$R1" -Extra @('-ExpectManifestSha256', $f.V)
            Test-Case "cli: -ExpectManifestSha256 $($f.N) is refused before any Run is read, store unchanged" ($o.ExitCode -eq 1 -and $o.Error -match 'invalid field: ExpectManifestSha256 \(bad_value\)' -and $o.Error -notmatch 'target_check' -and (Test-BytesEqual $cb ([IO.File]::ReadAllBytes($cs))))
        }   # +5
        $o = Invoke-Cli $repo $cs 'gate:m6-start' -Extra @('-ExpectManifestSha256', $hc)
        Test-Case 'cli: -ExpectManifestSha256 with a gate target is refused (undefined_field), store unchanged' ($o.ExitCode -eq 1 -and $o.Error -match 'invalid field: ExpectManifestSha256 \(undefined_field\)' -and (Test-BytesEqual $cb ([IO.File]::ReadAllBytes($cs))))   # +1
        $o = Invoke-Cli $repo $cs 'something' -Extra @('-ExpectManifestSha256', $hc)
        Test-Case 'cli: -ExpectManifestSha256 with a text that is not a target is refused, store unchanged' ($o.ExitCode -eq 1 -and $o.Error -match 'ExpectManifestSha256' -and (Test-BytesEqual $cb ([IO.File]::ReadAllBytes($cs))))   # +1
        $o = Invoke-ChildPwsh $repo.Add @('-Verify', '-StorePath', $cs, '-ExpectManifestSha256', $hc)
        Test-Case 'cli: -ExpectManifestSha256 with -Verify is not accepted, store unchanged' ($o.ExitCode -ne 0 -and (Test-BytesEqual $cb ([IO.File]::ReadAllBytes($cs))))   # +1
        $refused = @(
            @{ N = 'a Run that does not exist'; T = ('run:' + (Get-Bid 95)); Code = 'run_not_verified'; Field = 'target \(unresolved_target\)' },
            @{ N = 'the short form run-0001'; T = 'run:run-0001'; Code = 'run_id_invalid'; Field = 'target \(unresolved_target\)' },
            @{ N = 'an upper-case Run id'; T = ('run:' + $R1.ToUpperInvariant()); Code = 'run_id_invalid'; Field = 'target \(unresolved_target\)' },
            @{ N = 'a Claim that is not in the Run'; T = "claim:$R1/clm-0009-r1"; Code = 'claim_not_found'; Field = 'target \(unresolved_target\)' },
            @{ N = 'a Claim of another Run'; T = "claim:$R1/clm-0005-r1"; Code = 'claim_not_found'; Field = 'target \(unresolved_target\)' },
            @{ N = 'a Claim id with a suffix'; T = "claim:$R1/clm-0001-r1x"; Code = ''; Field = 'target \(' }
        )
        foreach ($f in $refused) {
            $o = Invoke-Cli $repo $cs $f.T
            $codeOk = if ($f.Code) { $o.Error -match ('target_check: ' + $f.Code) } else { $true }
            Test-Case "cli: $($f.N) is refused, store unchanged" ($o.ExitCode -eq 1 -and $o.Error -match ('invalid field: ' + $f.Field) -and $codeOk -and (Test-BytesEqual $cb ([IO.File]::ReadAllBytes($cs))))
        }   # +6
        $o = Invoke-Cli $repo $cs "run:$R1`n"
        Test-Case 'cli: a Run target with a trailing line feed is not shortened silently; it is refused (target is not valid)' ($o.ExitCode -eq 1 -and $o.Error -match 'invalid field: target \(bad_value\)' -and $o.Error -notmatch 'target_check' -and (Test-BytesEqual $cb ([IO.File]::ReadAllBytes($cs))))   # +1
        $o = Invoke-Cli $repo $cs "claim:$R1/clm-0001-r1`n"
        Test-Case 'cli: a Claim target with a trailing line feed is refused' ($o.ExitCode -eq 1 -and $o.Error -match 'invalid field: target \(bad_value\)' -and (Test-BytesEqual $cb ([IO.File]::ReadAllBytes($cs))))   # +1
        $o = Invoke-Cli $repo $cs 'run:../x'
        Test-Case 'cli: a Run target with a path traversal is refused' ($o.ExitCode -eq 1 -and $o.Error -match 'invalid field: target' -and (Test-BytesEqual $cb ([IO.File]::ReadAllBytes($cs))))   # +1
        $o = Invoke-Cli $repo $cs "run:$R1" -NoActor
        Test-Case 'cli: a run approval without -Actor is refused (recorded_by), store unchanged' ($o.ExitCode -eq 1 -and $o.Error -match 'invalid field: recorded_by \(missing_field\)' -and (Test-BytesEqual $cb ([IO.File]::ReadAllBytes($cs))))   # +1
        $o = Invoke-Cli $repo $cs "run:$R1" -Decision 'maybe'
        Test-Case 'cli: a decision outside the set is refused for a run target, store unchanged' ($o.ExitCode -eq 1 -and $o.Error -match 'invalid field: decision' -and (Test-BytesEqual $cb ([IO.File]::ReadAllBytes($cs))))   # +1
        # supersedes through the command
        $cs2 = New-StorePath
        $o = Invoke-Cli $repo $cs2 "run:$R1"
        $o2 = Invoke-Cli $repo $cs2 "run:$R1" -Decision 'rejected' -Extra @('-Supersedes', '1')
        Test-Case 'cli: -Supersedes of the same run target is stored (seq 2)' ($o.ExitCode -eq 0 -and $o2.ExitCode -eq 0 -and (Get-StoreLineCount $cs2) -eq 2 -and (Get-LastStoreLine $cs2)['supersedes'] -eq 1)   # +1
        $cb2 = [IO.File]::ReadAllBytes($cs2)
        $o = Invoke-Cli $repo $cs2 "run:$R1" -Extra @('-Supersedes', '1')
        Test-Case 'cli: -Supersedes of a record that is already superseded is refused' ($o.ExitCode -eq 1 -and $o.Error -match 'invalid field: supersedes \(supersedes_already_superseded\)' -and (Test-BytesEqual $cb2 ([IO.File]::ReadAllBytes($cs2))))   # +1
        $o = Invoke-Cli $repo $cs2 "claim:$R1/clm-0001-r1" -Extra @('-Supersedes', '2')
        Test-Case 'cli: -Supersedes of a record with another target is refused' ($o.ExitCode -eq 1 -and $o.Error -match 'invalid field: supersedes \(supersedes_target_differs\)' -and (Test-BytesEqual $cb2 ([IO.File]::ReadAllBytes($cs2))))   # +1
        # anchor through the command
        $ad = New-TempDir
        $ap = New-AnchorFile -Store $cs2 -Dir $ad
        $apSnap = (Get-FileHash -LiteralPath $ap).Hash + '|' + (Get-Item -LiteralPath $ap).LastWriteTimeUtc.Ticks
        $o = Invoke-Cli $repo $cs2 "claim:$R1/clm-0002-r1" -Extra @('-AnchorPath', $ap)
        Test-Case 'cli: a valid anchor with a claim target: stored' ($o.ExitCode -eq 0 -and (Get-StoreLineCount $cs2) -eq 3)   # +1
        $cb3 = [IO.File]::ReadAllBytes($cs2)
        $o = Invoke-Cli $repo $cs2 "run:$R1" -Extra @('-AnchorPath', (Join-Path $ad 'missing.txt'))
        Test-Case 'cli: an anchor that is missing is refused (exit 2, anchor_rejected), store unchanged' ($o.ExitCode -eq 2 -and $o.Error -match 'anchor_rejected' -and (Test-BytesEqual $cb3 ([IO.File]::ReadAllBytes($cs2))))   # +1
        $apBad = New-AnchorFile -Store $cs2 -Dir $ad -Name 'wrong.txt' -HashOverride ('8' * 64)
        $o = Invoke-Cli $repo $cs2 "run:$R1" -Extra @('-AnchorPath', $apBad)
        Test-Case 'cli: an anchor with another hash is refused (exit 2, store_invalid), store unchanged' ($o.ExitCode -eq 2 -and $o.Error -match 'store_invalid' -and (Test-BytesEqual $cb3 ([IO.File]::ReadAllBytes($cs2))))   # +1
        # nothing in the output of a refusal that identifies the Run, the path, the hash or the record
        $leak = @(
            (Invoke-Cli $repo $cs "run:$R1" -Extra @('-ExpectManifestSha256', ('3' * 64))),
            (Invoke-Cli $repo $cs ('run:' + (Get-Bid 95))),
            (Invoke-Cli $repo $cs "claim:$R1/clm-0009-r1")
        )
        foreach ($l in $leak) {
            $all = $l.Output + $l.Error
            Test-Case 'cli: a refusal prints no path, manifest hash, record id, Run content or rationale' ($l.ExitCode -eq 1 -and -not $all.Contains($repo.Root) -and -not $all.Contains($hc) -and -not $all.Contains('hyp-1') -and -not $all.Contains('Synthetic CLI approval') -and -not $all.Contains('records.jsonl') -and -not $all.Contains('manifest.json'))
        }   # +3
        Test-Case 'cli: the Runs of the synthetic repository are byte-, list- and time-identical after all command cases' ((Get-Snapshot $repo.Runs) -ceq $repoSnap)   # +1
        Test-Case 'cli: the anchor file (content and time) is unchanged by the command' (((Get-FileHash -LiteralPath $ap).Hash + '|' + (Get-Item -LiteralPath $ap).LastWriteTimeUtc.Ticks) -ceq $apSnap)   # +1

        # ------------------------------------------------------------------------------------------------ 9. results and static checks
        Write-Host '--- 9. results and static checks' -ForegroundColor Cyan
        $codes = Get-ApprovalTargetCodes
        $strange = @($script:FailResults | Where-Object { $codes -cnotcontains $_.Code -or $null -ne $_.ManifestSha256 -or @($_.PSObject.Properties).Count -ne 3 })
        Test-Case 'every refusal of the check is one of the fixed codes, carries no manifest hash, and has only Ok, Code and ManifestSha256' ($script:FailResults.Count -gt 50 -and $strange.Count -eq 0)   # +1
        $seen = @($script:FailResults | ForEach-Object { $_.Code } | Sort-Object -Unique)
        $mustSee = @('target_invalid', 'run_id_invalid', 'claim_id_invalid', 'expected_hash_invalid', 'run_not_verified', 'verified_data_missing', 'manifest_run_id_mismatch', 'manifest_changed', 'manifest_hash_mismatch', 'records_invalid', 'claim_record_invalid', 'claim_not_found', 'claim_ambiguous')
        Test-Case 'the tests exercised each of the refusal codes that a check can return' (@($mustSee | Where-Object { $seen -cnotcontains $_ }).Count -eq 0) (($mustSee | Where-Object { $seen -cnotcontains $_ }) -join ',')   # +1

        $modPath = Join-Path $script:ToolsDir 'ApprovalTargetResolver.psm1'
        $modText = Get-Content -Raw -LiteralPath $modPath
        $modCode = (($modText -split "`n") | Where-Object { $_ -notmatch '^\s*#' }) -join "`n"
        $writeApi = '\[(System\.)?IO\.File\]::(Write|Append|Replace|Move|Copy|Delete|Create|Set)|FileMode\]::(Create|CreateNew|Append|Truncate|OpenOrCreate)|FileAccess\]::(Write|ReadWrite)|Set-Content|Add-Content|Out-File|New-Item|Remove-Item|Move-Item|Copy-Item|Rename-Item|Clear-Content|Set-ItemProperty|Start-Process|ProcessStartInfo|Invoke-Expression|Invoke-WebRequest|Invoke-RestMethod'
        Test-Case 'static: ApprovalTargetResolver.psm1 contains no write, process, or network API' ($modCode -notmatch $writeApi)   # +1
        Test-Case 'static: ApprovalTargetResolver.psm1 opens no file itself (the verified read is the only read)' ($modCode -notmatch 'ReadAll(Bytes|Text|Lines)|Get-Content|IO\.File\]::Open|FileStream|StreamReader|Test-Path')   # +1
        Test-Case 'static: it does not name the store writer, an environment variable, or an exception message' ($modCode -notmatch 'Invoke-ApprovalStoreRequest|ApprovalStore\.psm1|\$env:|Exception\.Message|\$_\.Exception|\$_\.ToString|Write-Error|throw |Write-Host|Write-Output')   # +1
        Test-Case 'static: it does not use the unbounded or format-only helpers (Test-CompletedRun, Test-RunId, Test-RunIdFormat)' ($modCode -notmatch 'Test-CompletedRun|Test-RunId\b|Test-RunIdFormat')   # +1
        $tk = $null; $er = $null
        $ast = [System.Management.Automation.Language.Parser]::ParseFile($modPath, [ref]$tk, [ref]$er)
        $calls = @($ast.FindAll({ param($n) $n -is [System.Management.Automation.Language.CommandAst] -and $n.GetCommandName() -ceq 'Test-RunDirectory' }, $true))
        $callParams = if ($calls.Count -eq 1) { @($calls[0].CommandElements | Where-Object { $_ -is [System.Management.Automation.Language.CommandParameterAst] } | ForEach-Object { $_.ParameterName }) } else { @() }
        Test-Case 'static: exactly one call of Test-RunDirectory, with -Bounded -RequireMarker -RejectReparsePoints -IncludeVerifiedData and no limit parameter' ($er.Count -eq 0 -and $calls.Count -eq 1 -and (($callParams | Sort-Object) -join ',') -ceq 'Bounded,IncludeVerifiedData,Path,RejectReparsePoints,RequireMarker')   # +1
        $exports = @((Get-Module ApprovalTargetResolver).ExportedFunctions.Keys | Sort-Object)
        Test-Case 'static: the module exports the documented functions only' (($exports -join ',') -ceq 'Find-ApprovalClaimRevision,Get-ApprovalRecordKinds,Get-ApprovalTargetCodes,Invoke-ApprovalTargetCheck,New-ApprovalTargetControl,Read-ApprovalRunRecords,Test-ApprovalClaimRevisionId,Test-ApprovalRunId')   # +1
        $schemaText = Get-Content -Raw -LiteralPath (Join-Path $script:RepoRoot 'packages/discovery-loop/src/schema/schemas.ts')
        $km = [regex]::Match($schemaText, 'const RECORD_KINDS = \[(.*?)\];', [System.Text.RegularExpressions.RegexOptions]::Singleline)
        $tsKinds = @([regex]::Matches($km.Groups[1].Value, '"([a-z_]+)"') | ForEach-Object { $_.Groups[1].Value })
        Test-Case 'static: the record kinds of the module equal RECORD_KINDS of the TypeScript record-envelope schema, in order' ($km.Success -and $tsKinds.Count -eq 21 -and ($tsKinds -join ',') -ceq ((Get-ApprovalRecordKinds) -join ','))   # +1
        $addPath = Join-Path $script:ToolsDir 'Add-ApprovalRecord.ps1'
        $addText = Get-Content -Raw -LiteralPath $addPath
        $at = $null; $ae = $null
        $aast = [System.Management.Automation.Language.Parser]::ParseFile($addPath, [ref]$at, [ref]$ae)
        $aparams = @($aast.ParamBlock.Parameters)
        $names = @($aparams | ForEach-Object { $_.Name.VariablePath.UserPath })
        $expectParam = @($aparams | Where-Object { $_.Name.VariablePath.UserPath -eq 'ExpectManifestSha256' })
        Test-Case 'static: Add-ApprovalRecord.ps1 declares no runs-root, path-override, or limit parameter' ($ae.Count -eq 0 -and @($names | Where-Object { $_ -match 'Run|Root|Limit|Max|Bound|Skip|Bypass|Force' }).Count -eq 0) ($names -join ',')   # +1
        Test-Case 'static: ExpectManifestSha256 is an optional string without default, only in the Record parameter set' ($expectParam.Count -eq 1 -and $null -eq $expectParam[0].DefaultValue -and $expectParam[0].StaticType -eq [string] -and (@($expectParam[0].Attributes | Where-Object { $_.TypeName.Name -eq 'Parameter' -and ($_.NamedArguments | Where-Object { $_.ArgumentName -eq 'Mandatory' }) }).Count -eq 0) -and $addText -match "ParameterSetName = 'Record'\)\]\[string\]\`$ExpectManifestSha256")   # +1
        Test-Case 'static: the command passes the resolver only for run and claim targets, from the fixed runs directory of the tools, and never for a gate' ($addText -match '\$isRunTarget' -and $addText -match "if \(\`$isRunTarget\) \{" -and $addText -match "Join-Path \`$PSScriptRoot '\.\./runs'" -and $addText -match '@anchorArgs @resolverArgs' -and $addText -notmatch '\$env:')   # +1
        $users = @(Get-ChildItem -LiteralPath $script:ToolsDir -File | Where-Object { $_.Extension -in '.ps1', '.psm1' -and $_.Name -ne 'ApprovalTargetResolver.psm1' } | Where-Object { (Get-Content -Raw -LiteralPath $_.FullName) -match 'ApprovalTargetResolver' } | ForEach-Object { $_.Name })
        Test-Case 'static: only Add-ApprovalRecord.ps1 uses the resolver module (the store layer, the Launcher and the other tools do not)' (($users -join ',') -ceq 'Add-ApprovalRecord.ps1') ($users -join ',')   # +1
        $selfText = Get-Content -Raw -LiteralPath $PSCommandPath
        Test-Case 'static: this test creates its Runs, stores and anchors only below the temporary directory (no repository Run path is built)' (-not ($selfText -match ('RepoRoot [''"]?discovery' + '|Join-Path \$script:RepoRoot [''"]discovery')))   # +1
    } finally { Remove-Links }
}
