#Requires -Version 7.0
# Bounded Run verification (task 4.10, part B3a): Test-RunDirectory -Bounded of discovery/tools/DiscoveryCommon.psm1.
# Synthetic data only: every Run is a copy of the synthetic test vector packages/discovery-loop/test-vectors/sealed-run in a temporary
# directory (plus generated files). Links are created only inside temporary directories and point at synthetic temporary files.
# No Docker, no network, no real Run, no Approval_Store, no Launcher, no configuration. Budgets are small values that are injected through
# the parameters, so no large file is created.
. (Join-Path $PSScriptRoot 'lib/testlib.ps1')
Import-Module (Join-Path $script:ToolsDir 'DiscoveryCommon.psm1') -Force -DisableNameChecking
$mod = Get-Module DiscoveryCommon
$vec = Join-Path $script:RepoRoot 'packages/discovery-loop/test-vectors/sealed-run'
$utf8 = [System.Text.UTF8Encoding]::new($false)
$script:Links = [System.Collections.Generic.List[string]]::new()

Add-Type -TypeDefinition @'
public class PhxEndlessStream : System.IO.Stream {
    public long Served;
    public override bool CanRead { get { return true; } }
    public override bool CanSeek { get { return false; } }
    public override bool CanWrite { get { return false; } }
    public override long Length { get { throw new System.NotSupportedException(); } }
    public override long Position { get { throw new System.NotSupportedException(); } set { throw new System.NotSupportedException(); } }
    public override void Flush() { }
    public override int Read(byte[] buffer, int offset, int count) { System.Array.Clear(buffer, offset, count); Served += count; return count; }
    public override long Seek(long offset, System.IO.SeekOrigin origin) { throw new System.NotSupportedException(); }
    public override void SetLength(long value) { throw new System.NotSupportedException(); }
    public override void Write(byte[] buffer, int offset, int count) { throw new System.NotSupportedException(); }
}
'@

function Set-Marker { param([string]$Dir) [IO.File]::WriteAllText((Join-Path $Dir 'COMPLETE'), (Get-Sha256HexOfFile -Path (Join-Path $Dir 'manifest.json'))) }
function New-SynthRun {
    param([string]$Name = 'run', [string]$Parent)
    if (-not $Parent) { $Parent = New-TempDir }
    $dir = Join-Path $Parent $Name
    Copy-Item -LiteralPath $vec -Destination $dir -Recurse
    Set-Marker -Dir $dir
    $dir
}
# Lists one more file as an artifact of the manifest (and writes it), then rewrites COMPLETE.
function Add-SynthArtifact {
    param([string]$Dir, [string]$Rel, [byte[]]$Bytes)
    $full = Join-Path $Dir ($Rel -replace '/', [IO.Path]::DirectorySeparatorChar)
    [void][IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($full))
    [IO.File]::WriteAllBytes($full, $Bytes)
    $mp = Join-Path $Dir 'manifest.json'
    $m = ConvertFrom-JsonStrict -Text ($utf8.GetString([IO.File]::ReadAllBytes($mp)).TrimEnd("`n"))
    $m['artifacts'].Add([ordered]@{ path = $Rel; sha256 = (Get-Sha256Hex -Bytes $Bytes) })
    [IO.File]::WriteAllBytes($mp, $utf8.GetBytes((ConvertTo-CanonicalJson -Value $m) + "`n"))
    Set-Marker -Dir $Dir
}
function Add-SynthBlob {
    param([string]$Dir, [byte[]]$Bytes)
    $h = Get-Sha256Hex -Bytes $Bytes
    Add-SynthArtifact -Dir $Dir -Rel "blobs/$h" -Bytes $Bytes
    $h
}
function New-Link {
    param([string]$Path, [string]$Target, [switch]$Junction)
    if ($Junction) { $o = cmd /c mklink /J "$Path" "$Target" 2>&1; if ($LASTEXITCODE -ne 0) { throw "mklink /J failed: $o" } }
    else { New-Item -ItemType SymbolicLink -Path $Path -Target $Target -ErrorAction Stop | Out-Null }
    $script:Links.Add($Path)
}
function Remove-Links {
    foreach ($l in $script:Links) {
        try {
            $a = [IO.File]::GetAttributes($l)
            if (($a -band [IO.FileAttributes]::Directory) -ne 0) { [IO.Directory]::Delete($l) } else { [IO.File]::Delete($l) }
        } catch { }
    }
    $script:Links.Clear()
}
function Get-Names { param($R) @($R.Mismatches | ForEach-Object { "$($_.Where):$($_.Kind)" }) }
function Get-Snapshot {
    param([string]$Dir)
    (Get-ChildItem -LiteralPath $Dir -Recurse -Force | Sort-Object FullName | ForEach-Object {
            if ($_.PSIsContainer) { "D|$($_.FullName.Substring($Dir.Length))|$($_.LastWriteTimeUtc.Ticks)" }
            else { "F|$($_.FullName.Substring($Dir.Length))|$($_.Length)|$((Get-FileHash -LiteralPath $_.FullName).Hash)|$($_.LastWriteTimeUtc.Ticks)" }
        }) -join "`n"
}
function Get-FailCode { param($R) if ($R.Incomplete) { $R.IncompleteReason } else { '(not incomplete)' } }
function Test-BoundFailure {
    param($R, [string]$Code)
    $R.Result -ceq 'failure' -and $R.Incomplete -eq $true -and $R.IncompleteReason -ceq $Code -and $null -eq $R.ManifestSha256 -and $null -eq $R.Detail -and @($R.Mismatches).Count -eq 0
}

Invoke-TestMain {
    try {
        Write-Host '=== Bounded Run verification (B3a): synthetic Runs only ===' -ForegroundColor Cyan
        $baseRun = New-SynthRun
        $lenManifest = ([IO.FileInfo](Join-Path $baseRun 'manifest.json')).Length
        $lenMarker = ([IO.FileInfo](Join-Path $baseRun 'COMPLETE')).Length
        $lenRecords = ([IO.FileInfo](Join-Path $baseRun 'records.jsonl')).Length
        $blobFile = @(Get-ChildItem -LiteralPath (Join-Path $baseRun 'blobs') -File)[0]
        $lenAll = $lenManifest + $lenMarker + $lenRecords + $blobFile.Length

        # ---- compatibility: the default is the existing behavior, and the existing detections hold in both modes
        $plain = Test-RunDirectory -Path $baseRun -RequireMarker
        Test-Case 'compat: without options the result has exactly the existing six properties (no new property)' ((@($plain.PSObject.Properties.Name) -join ',') -ceq 'Result,Incomplete,IncompleteReason,Detail,Mismatches,ManifestSha256') (@($plain.PSObject.Properties.Name) -join ',')
        Test-Case 'compat: without options a valid Run is a success and Test-CompletedRun accepts it' ($plain.Result -ceq 'success' -and $plain.Incomplete -eq $false -and $null -eq $plain.IncompleteReason -and $null -eq $plain.Detail -and @($plain.Mismatches).Count -eq 0 -and (Test-CompletedRun -Path $baseRun))
        $bd = Test-RunDirectory -Path $baseRun -RequireMarker -Bounded -RejectReparsePoints
        Test-Case 'compat: the bounded mode (defaults, links refused) accepts the same Run with the same result and the same six properties' ($bd.Result -ceq 'success' -and $bd.ManifestSha256 -ceq $plain.ManifestSha256 -and (@($bd.PSObject.Properties.Name) -join ',') -ceq (@($plain.PSObject.Properties.Name) -join ','))
        $modes = [ordered]@{ plain = @{}; bounded = @{ Bounded = $true; RejectReparsePoints = $true } }
        foreach ($mn in $modes.Keys) {
            $sp = $modes[$mn]
            $d = New-SynthRun; Remove-Item -LiteralPath (Join-Path $d 'COMPLETE')
            $r = Test-RunDirectory -Path $d -RequireMarker @sp
            Test-Case "compat [$mn]: no COMPLETE is no_completion_marker" ($r.Incomplete -and $r.IncompleteReason -ceq 'no_completion_marker' -and $r.ManifestSha256 -cmatch '^[0-9a-f]{64}$')
            $d = New-SynthRun; Remove-Item -LiteralPath (Join-Path $d 'manifest.json')
            $r = Test-RunDirectory -Path $d -RequireMarker @sp
            Test-Case "compat [$mn]: no manifest is no_manifest" ($r.Incomplete -and $r.IncompleteReason -ceq 'no_manifest' -and $null -eq $r.ManifestSha256)
            $d = New-SynthRun; [IO.File]::WriteAllText((Join-Path $d 'manifest.json'), '{'); Set-Marker $d
            $r = Test-RunDirectory -Path $d -RequireMarker @sp
            Test-Case "compat [$mn]: an invalid manifest is manifest_invalid" ($r.Incomplete -and $r.IncompleteReason -ceq 'manifest_invalid')
            $d = New-SynthRun; $bf = @(Get-ChildItem -LiteralPath (Join-Path $d 'blobs') -File)[0]; $bb = [IO.File]::ReadAllBytes($bf.FullName); $bb[0] = $bb[0] -bxor 1; [IO.File]::WriteAllBytes($bf.FullName, $bb)
            $r = Test-RunDirectory -Path $d -RequireMarker @sp
            Test-Case "compat [$mn]: a changed artifact is reported as modified" ($r.Result -ceq 'failure' -and -not $r.Incomplete -and (Get-Names $r) -contains "blobs/$($bf.Name):modified") ((Get-Names $r) -join ',')
            $d = New-SynthRun; $bf = @(Get-ChildItem -LiteralPath (Join-Path $d 'blobs') -File)[0]; Remove-Item -LiteralPath $bf.FullName
            $r = Test-RunDirectory -Path $d -RequireMarker @sp
            Test-Case "compat [$mn]: a removed artifact is reported as missing" ($r.Result -ceq 'failure' -and (Get-Names $r) -contains "blobs/$($bf.Name):missing") ((Get-Names $r) -join ',')
            $d = New-SynthRun; [IO.File]::WriteAllText((Join-Path $d 'extra.txt'), 'x'); [void][IO.Directory]::CreateDirectory((Join-Path $d 'sub')); [IO.File]::WriteAllText((Join-Path $d 'sub/deep.txt'), 'y')
            $r = Test-RunDirectory -Path $d -RequireMarker @sp
            Test-Case "compat [$mn]: files that the manifest does not list (also in a subdirectory) are reported as unlisted" ($r.Result -ceq 'failure' -and (Get-Names $r) -contains 'extra.txt:unlisted' -and (Get-Names $r) -contains 'sub/deep.txt:unlisted') ((Get-Names $r) -join ',')
            $d = New-SynthRun; $rp = Join-Path $d 'records.jsonl'; $rb = [IO.File]::ReadAllBytes($rp); $rb[12] = $rb[12] -bxor 1; [IO.File]::WriteAllBytes($rp, $rb)
            $r = Test-RunDirectory -Path $d -RequireMarker @sp
            Test-Case "compat [$mn]: a changed record is modified (artifact) and a chain_break" ($r.Result -ceq 'failure' -and (Get-Names $r) -contains 'records.jsonl:modified' -and @(Get-Names $r | Where-Object { $_ -like '*:chain_break' }).Count -ge 1) ((Get-Names $r) -join ',')
            $d = New-SynthRun; $mp = Join-Path $d 'manifest.json'; $m = ConvertFrom-JsonStrict -Text ([IO.File]::ReadAllText($mp).TrimEnd("`n")); $m['chain']['lastHash'] = 'f' * 64
            [IO.File]::WriteAllBytes($mp, $utf8.GetBytes((ConvertTo-CanonicalJson -Value $m) + "`n")); Set-Marker $d
            $r = Test-RunDirectory -Path $d -RequireMarker @sp
            Test-Case "compat [$mn]: a manifest chain value that differs from the records is a chain_break at manifest.chain" ($r.Result -ceq 'failure' -and (Get-Names $r) -contains 'manifest.chain:chain_break') ((Get-Names $r) -join ',')
            $d = New-SynthRun; [IO.File]::WriteAllText((Join-Path $d 'COMPLETE'), ('0' * 64))
            $r = Test-RunDirectory -Path $d -RequireMarker @sp
            Test-Case "compat [$mn]: a COMPLETE that differs from the manifest hash: the verification itself succeeds and Test-CompletedRun refuses" ($r.Result -ceq 'success' -and -not (Test-CompletedRun -Path $d))
        }
        $d = New-SynthRun; [IO.File]::WriteAllText((Join-Path $d 'COMPLETE'), "$($plain.ManifestSha256)`r`n")
        Test-Case 'compat: a COMPLETE with a trailing CR LF is accepted as before (the existing marker rule)' (Test-CompletedRun -Path $d)
        foreach ($mn in $modes.Keys) {
            $sp = $modes[$mn]
            foreach ($bad in '../x', 'a\b', '/abs') {
                $d = New-SynthRun; $mp = Join-Path $d 'manifest.json'; $m = ConvertFrom-JsonStrict -Text ([IO.File]::ReadAllText($mp).TrimEnd("`n"))
                $m['artifacts'].Add([ordered]@{ path = $bad; sha256 = ('a' * 64) }); [IO.File]::WriteAllBytes($mp, $utf8.GetBytes((ConvertTo-CanonicalJson -Value $m) + "`n")); Set-Marker $d
                $r = Test-RunDirectory -Path $d -RequireMarker @sp
                Test-Case "path [$mn]: the artifact path '$bad' is refused by the existing relative-path rule (manifest_invalid)" ($r.Incomplete -and $r.IncompleteReason -ceq 'manifest_invalid') (Get-FailCode $r)
            }
        }

        # ---- read budget (small budgets are injected)
        $vd = Test-RunDirectory -Path $baseRun -RequireMarker -Bounded -IncludeVerifiedData
        Test-Case 'budget: the raw bytes read are exactly the four files (manifest, COMPLETE, records, the one blob)' ($vd.VerifiedData.BytesRead -eq $lenAll) "read=$($vd.VerifiedData.BytesRead) expected=$lenAll"
        $r = Test-RunDirectory -Path $baseRun -RequireMarker -Bounded -MaxTotalBytes ($lenAll + 1000)
        Test-Case 'budget: a budget above the total is accepted' ($r.Result -ceq 'success')
        $r = Test-RunDirectory -Path $baseRun -RequireMarker -Bounded -MaxTotalBytes $lenAll
        Test-Case 'budget: a budget equal to the total is accepted' ($r.Result -ceq 'success')
        $r = Test-RunDirectory -Path $baseRun -RequireMarker -Bounded -MaxTotalBytes ($lenAll - 1)
        Test-Case 'budget: a budget one byte below the total fails as budget_exceeded, with no hash, no detail, and no success data' (Test-BoundFailure $r 'budget_exceeded') (Get-FailCode $r)
        $r = Test-RunDirectory -Path $baseRun -RequireMarker -Bounded -MaxTotalBytes ($lenManifest + $lenMarker + $lenRecords)
        Test-Case 'budget: the sum of several files crosses the budget in the artifact hashing (each file alone is below it)' (Test-BoundFailure $r 'budget_exceeded') (Get-FailCode $r)
        $r = Test-RunDirectory -Path $baseRun -RequireMarker -Bounded -MaxManifestBytes $lenManifest
        Test-Case 'budget: a manifest limit equal to the manifest size is accepted' ($r.Result -ceq 'success')
        $r = Test-RunDirectory -Path $baseRun -RequireMarker -Bounded -MaxManifestBytes ($lenManifest - 1)
        Test-Case 'budget: a manifest one byte above its limit fails as file_too_large' (Test-BoundFailure $r 'file_too_large') (Get-FailCode $r)
        $r = Test-RunDirectory -Path $baseRun -RequireMarker -Bounded -MaxMarkerBytes $lenMarker
        Test-Case 'budget: a COMPLETE limit equal to its size (64 bytes) is accepted' ($lenMarker -eq 64 -and $r.Result -ceq 'success')
        $r = Test-RunDirectory -Path $baseRun -RequireMarker -Bounded -MaxMarkerBytes ($lenMarker - 1)
        Test-Case 'budget: a COMPLETE one byte above its limit fails as file_too_large' (Test-BoundFailure $r 'file_too_large') (Get-FailCode $r)
        $d = New-SynthRun; [IO.File]::WriteAllText((Join-Path $d 'COMPLETE'), ($plain.ManifestSha256 + (' ' * 200)))
        $r = Test-RunDirectory -Path $d -RequireMarker -Bounded
        Test-Case 'budget: a COMPLETE of 264 bytes fails with the default marker limit' (Test-BoundFailure $r 'file_too_large') (Get-FailCode $r)
        $rf = Join-Path $baseRun 'records.jsonl'
        $ctx = & $mod { param($t, $m, $k) New-RunReadContext -Bounded $true -Reject $false -Total $t -Manifest $m -Marker $k -Entries 100 -Depth 16 } 1000000 1000000 1000000
        $okRead = & $mod { param($c, $p, $l) Read-RunFile -Ctx $c -Path $p -Role 'records' -FileLimit $l } $ctx $rf $lenRecords
        Test-Case 'budget: records.jsonl read with a limit equal to its size is returned whole (and counted)' ($okRead.Count -eq $lenRecords -and $okRead.Bytes.Length -eq $lenRecords -and $ctx.Used -eq $lenRecords)
        $ctx = & $mod { param($t, $m, $k) New-RunReadContext -Bounded $true -Reject $false -Total $t -Manifest $m -Marker $k -Entries 100 -Depth 16 } 1000000 1000000 1000000
        $msg = ''; try { & $mod { param($c, $p, $l) Read-RunFile -Ctx $c -Path $p -Role 'records' -FileLimit $l } $ctx $rf ($lenRecords - 1) | Out-Null } catch { $msg = $_.Exception.Message }
        Test-Case 'budget: records.jsonl one byte above its limit fails as file_too_large; the one extra byte is counted as read' ($msg -ceq 'RUNBOUND:file_too_large' -and $ctx.Used -eq $lenRecords) "msg=$msg used=$($ctx.Used)"
        $big = New-Object byte[] 200000; [Array]::Fill($big, [byte]7); $bigFile = Join-Path (New-TempDir) 'big.bin'; [IO.File]::WriteAllBytes($bigFile, $big)
        $ctx = & $mod { param($t, $m, $k) New-RunReadContext -Bounded $true -Reject $false -Total $t -Manifest $m -Marker $k -Entries 100 -Depth 16 } 100000 1000000 1000000
        $msg = ''; try { & $mod { param($c, $p) Read-RunFile -Ctx $c -Path $p -Role 'artifact' -HashOnly } $ctx $bigFile | Out-Null } catch { $msg = $_.Exception.Message }
        Test-Case 'budget: the hash computation of an artifact is counted and stops at the budget plus one byte (it does not read the whole file)' ($msg -ceq 'RUNBOUND:budget_exceeded' -and $ctx.Used -eq 100001) "msg=$msg used=$($ctx.Used)"
        $d = New-SynthRun; [void](Add-SynthBlob -Dir $d -Bytes $big)
        $r = Test-RunDirectory -Path $d -RequireMarker -Bounded -MaxTotalBytes 100000
        Test-Case 'budget: a Run with a large listed artifact fails as budget_exceeded through the public function' (Test-BoundFailure $r 'budget_exceeded') (Get-FailCode $r)
        # The expected read size of this fixture, computed independently from the file sizes after the fixture is complete (each file once:
        # manifest.json, COMPLETE, records.jsonl, every file under blobs/). No value of the product (VerifiedData, counters, reader) is used.
        $bigRunBytes = [long]0
        foreach ($n in 'manifest.json', 'COMPLETE', 'records.jsonl') { $bigRunBytes += ([IO.FileInfo](Join-Path $d $n)).Length }
        foreach ($f in Get-ChildItem -LiteralPath (Join-Path $d 'blobs') -File -Force) { $bigRunBytes += $f.Length }
        $r = Test-RunDirectory -Path $d -RequireMarker -Bounded -MaxTotalBytes $bigRunBytes
        Test-Case 'budget: the same Run with a budget equal to its independently computed size is accepted (the limit is a real limit, not a rejection of large artifacts)' ($bigRunBytes -gt 200000 -and $r.Result -ceq 'success') "budget=$bigRunBytes result=$($r.Result)"
        $r = Test-RunDirectory -Path $d -RequireMarker -Bounded -MaxTotalBytes ($bigRunBytes - 1)
        Test-Case 'budget: the same Run with a budget one byte below its independently computed size fails as budget_exceeded' (Test-BoundFailure $r 'budget_exceeded') (Get-FailCode $r)
        $es = [PhxEndlessStream]::new()
        $ctx = & $mod { param($t, $m, $k) New-RunReadContext -Bounded $true -Reject $false -Total $t -Manifest $m -Marker $k -Entries 100 -Depth 16 } 1000000 1000 1000000
        $msg = ''; try { & $mod { param($s, $c) Read-RunStream -Stream $s -Ctx $c -FileLimit 1000 } $es $ctx | Out-Null } catch { $msg = $_.Exception.Message }
        Test-Case 'growth: a stream with no end (a file that grows after the size check; Length is not available) stops at the limit plus one byte' ($msg -ceq 'RUNBOUND:file_too_large' -and $ctx.Used -eq 1001) "msg=$msg used=$($ctx.Used) served=$($es.Served)"
        Test-Case 'growth: the endless source was asked for no more than one buffer past the limit' ($es.Served -le 1001) "served=$($es.Served)"
        $ms = [IO.MemoryStream]::new((New-Object byte[] 5000))
        $ctx = & $mod { param($t, $m, $k) New-RunReadContext -Bounded $true -Reject $false -Total $t -Manifest $m -Marker $k -Entries 100 -Depth 16 } 1000000 1000000 1000000
        $rr = & $mod { param($s, $c) Read-RunStream -Stream $s -Ctx $c -FileLimit 5000 } $ms $ctx
        Test-Case 'growth: a stream of exactly the limit (spanning several 64 KiB-free reads) is read whole' ($rr.Count -eq 5000 -and $ctx.Used -eq 5000)
        $ctx = & $mod { New-RunReadContext -Bounded $false -Reject $false -Total ([long]::MaxValue) -Manifest ([long]::MaxValue) -Marker ([long]::MaxValue) -Entries ([long]::MaxValue) -Depth ([long]::MaxValue) }
        $ms = [IO.MemoryStream]::new((New-Object byte[] 150000))
        $rr = & $mod { param($s, $c) Read-RunStream -Stream $s -Ctx $c -FileLimit ([long]::MaxValue) } $ms $ctx
        Test-Case 'growth: without -Bounded the reader has no limit (150000 bytes over three chunks are read whole)' ($rr.Count -eq 150000)

        # invalid values
        foreach ($case in @(@('0', 0), @('negative', -1), @('text', 'abc'), @('double', 1.5), @('boolean', $true), @('Int64.MaxValue', [long]::MaxValue))) {
            $v = $case[1]
            Test-Throws "args: MaxTotalBytes = $($case[0]) is refused" { Test-RunDirectory -Path $baseRun -Bounded -MaxTotalBytes $v } '*MaxTotalBytes*'
        }
        Test-Throws 'args: a limit without -Bounded is refused (no limit is applied implicitly, and none is silently ignored)' { Test-RunDirectory -Path $baseRun -MaxEntries 5 } '*need -Bounded*'
        Test-Throws 'args: -RejectReparsePoints without -Bounded is refused' { Test-RunDirectory -Path $baseRun -RejectReparsePoints } '*need -Bounded*'
        Test-Throws 'args: -IncludeVerifiedData without -RequireMarker is refused' { Test-RunDirectory -Path $baseRun -Bounded -IncludeVerifiedData } '*needs -RequireMarker*'
        Test-Throws 'args: a negative MaxDepth is refused' { Test-RunDirectory -Path $baseRun -Bounded -MaxDepth -1 } '*MaxDepth*'

        # ---- enumeration
        Test-Case 'enum: the base Run has five entries (the blobs directory is counted with the four files)' ($vd.VerifiedData.EntryCount -eq 5) "count=$($vd.VerifiedData.EntryCount)"
        $r = Test-RunDirectory -Path $baseRun -RequireMarker -Bounded -MaxEntries 5
        Test-Case 'enum: a limit equal to the number of entries is accepted' ($r.Result -ceq 'success')
        $r = Test-RunDirectory -Path $baseRun -RequireMarker -Bounded -MaxEntries 4
        Test-Case 'enum: one entry above the limit fails as entry_limit' (Test-BoundFailure $r 'entry_limit') (Get-FailCode $r)
        $d = New-SynthRun; foreach ($n in 1..5) { [void][IO.Directory]::CreateDirectory((Join-Path $d "empty$n")) }
        $r = Test-RunDirectory -Path $d -RequireMarker -Bounded -MaxEntries 9
        $r2 = Test-RunDirectory -Path $d -RequireMarker -Bounded -MaxEntries 10
        Test-Case 'enum: empty directories are counted (five of them: 9 fails, 10 is accepted)' ((Test-BoundFailure $r 'entry_limit') -and $r2.Result -ceq 'success') "$(Get-FailCode $r) / $($r2.Result)"
        $d = New-SynthRun; [IO.File]::WriteAllText((Join-Path $d 'extra.txt'), 'x')
        $r = Test-RunDirectory -Path $d -RequireMarker -Bounded -MaxEntries 5
        $r2 = Test-RunDirectory -Path $d -RequireMarker -Bounded -MaxEntries 6
        Test-Case 'enum: an unlisted file is not overlooked by the limit: it fails the limit, and within the limit it is reported as unlisted' ((Test-BoundFailure $r 'entry_limit') -and $r2.Result -ceq 'failure' -and (Get-Names $r2) -contains 'extra.txt:unlisted') "$(Get-FailCode $r) / $((Get-Names $r2) -join ',')"
        $d = New-SynthRun; foreach ($n in 1..300) { [IO.File]::WriteAllText((Join-Path $d "f$n.txt"), 'x') }
        $r = Test-RunDirectory -Path $d -RequireMarker -Bounded -MaxEntries 10
        Test-Case 'enum: three hundred unlisted files against a limit of ten fail as entry_limit' (Test-BoundFailure $r 'entry_limit') (Get-FailCode $r)
        $d = New-SynthRun; [void](Add-SynthArtifact -Dir $d -Rel 'd1/d2/d3/deep.bin' -Bytes ([byte[]](1, 2, 3)))
        $r = Test-RunDirectory -Path $d -RequireMarker -Bounded -MaxDepth 3
        $r2 = Test-RunDirectory -Path $d -RequireMarker -Bounded -MaxDepth 2
        Test-Case 'depth: three nested directories are accepted with MaxDepth 3 and fail with MaxDepth 2 (depth_limit)' ($r.Result -ceq 'success' -and (Test-BoundFailure $r2 'depth_limit')) "$($r.Result) / $(Get-FailCode $r2)"
        $r = Test-RunDirectory -Path $baseRun -RequireMarker -Bounded -MaxDepth 0
        Test-Case 'depth: MaxDepth 0 does not enter the blobs directory (depth_limit)' (Test-BoundFailure $r 'depth_limit') (Get-FailCode $r)
        $d16 = New-SynthRun; [void](Add-SynthArtifact -Dir $d16 -Rel (((1..16 | ForEach-Object { "d$_" }) -join '/') + '/f.bin') -Bytes ([byte[]](9)))
        $d17 = New-SynthRun; [void](Add-SynthArtifact -Dir $d17 -Rel (((1..17 | ForEach-Object { "d$_" }) -join '/') + '/f.bin') -Bytes ([byte[]](9)))
        $r16 = Test-RunDirectory -Path $d16 -RequireMarker -Bounded; $r17 = Test-RunDirectory -Path $d17 -RequireMarker -Bounded
        Test-Case 'depth: with the default (16, as in the TypeScript walk) sixteen nested directories are accepted and seventeen fail' ($r16.Result -ceq 'success' -and (Test-BoundFailure $r17 'depth_limit')) "$($r16.Result) / $(Get-FailCode $r17)"
        $d = New-SynthRun; [void](Add-SynthArtifact -Dir $d -Rel 'd1/d2/d3/deep.bin' -Bytes ([byte[]](1, 2, 3)))
        $r = Test-RunDirectory -Path $d -RequireMarker -Bounded -MaxDepth 3 -MaxEntries 9
        $r2 = Test-RunDirectory -Path $d -RequireMarker -Bounded -MaxDepth 3 -MaxEntries 8
        Test-Case 'enum: directories at every level are counted (5 base entries + 3 nested directories + 1 file = 9: 9 passes, 8 fails)' ($r.Result -ceq 'success' -and (Test-BoundFailure $r2 'entry_limit')) "$($r.Result) / $(Get-FailCode $r2)"
        # ---- paths and links (the targets are synthetic temporary files)
        $outside = New-TempDir
        $d = New-SynthRun; $mp = Join-Path $d 'manifest.json'; $copy = Join-Path $outside 'manifest.json'; Copy-Item -LiteralPath $mp -Destination $copy; Remove-Item -LiteralPath $mp; New-Link -Path $mp -Target $copy
        $unb = Test-RunDirectory -Path $d -RequireMarker
        $bnd = Test-RunDirectory -Path $d -RequireMarker -Bounded
        $rej = Test-RunDirectory -Path $d -RequireMarker -Bounded -RejectReparsePoints
        Test-Case 'links: a manifest.json that is a file link is refused as reparse_point' (Test-BoundFailure $rej 'reparse_point') (Get-FailCode $rej)
        Test-Case 'links: without -RejectReparsePoints the same link is followed and the Run is accepted (the documented limit of the default and of -Bounded alone)' ($unb.Result -ceq 'success' -and $bnd.Result -ceq 'success')
        Remove-Links
        $d = New-SynthRun; $cp = Join-Path $d 'COMPLETE'; $copy = Join-Path $outside 'COMPLETE'; Copy-Item -LiteralPath $cp -Destination $copy; Remove-Item -LiteralPath $cp; New-Link -Path $cp -Target $copy
        $rej = Test-RunDirectory -Path $d -RequireMarker -Bounded -RejectReparsePoints
        Test-Case 'links: a COMPLETE that is a file link is refused as reparse_point' (Test-BoundFailure $rej 'reparse_point') (Get-FailCode $rej)
        Remove-Links
        $d = New-SynthRun; $rp = Join-Path $d 'records.jsonl'; $copy = Join-Path $outside 'records.jsonl'; Copy-Item -LiteralPath $rp -Destination $copy; Remove-Item -LiteralPath $rp; New-Link -Path $rp -Target $copy
        $rej = Test-RunDirectory -Path $d -RequireMarker -Bounded -RejectReparsePoints
        Test-Case 'links: a records.jsonl that is a file link is refused as reparse_point' (Test-BoundFailure $rej 'reparse_point') (Get-FailCode $rej)
        Remove-Links
        $d = New-SynthRun; $bf = @(Get-ChildItem -LiteralPath (Join-Path $d 'blobs') -File)[0]; $copy = Join-Path $outside 'blob.bin'; Copy-Item -LiteralPath $bf.FullName -Destination $copy; Remove-Item -LiteralPath $bf.FullName; New-Link -Path $bf.FullName -Target $copy
        $rej = Test-RunDirectory -Path $d -RequireMarker -Bounded -RejectReparsePoints
        Test-Case 'links: an artifact that is a file link is refused as reparse_point' (Test-BoundFailure $rej 'reparse_point') (Get-FailCode $rej)
        Remove-Links
        $d = New-SynthRun; $outBlobs = Join-Path $outside 'blobsdir'; Copy-Item -LiteralPath (Join-Path $d 'blobs') -Destination $outBlobs -Recurse; Remove-Item -LiteralPath (Join-Path $d 'blobs') -Recurse; New-Link -Path (Join-Path $d 'blobs') -Target $outBlobs -Junction
        $unb = Test-RunDirectory -Path $d -RequireMarker
        $rej = Test-RunDirectory -Path $d -RequireMarker -Bounded -RejectReparsePoints
        Test-Case 'links: a blobs directory that is a junction is refused as reparse_point, and nothing below it is read' (Test-BoundFailure $rej 'reparse_point') (Get-FailCode $rej)
        Test-Case 'links: without -RejectReparsePoints the artifact below the junction is read through it (documented limit; the default mode)' ($unb.Result -ceq 'success')
        Remove-Links
        $d = New-SynthRun; Copy-Item -LiteralPath (Join-Path $d 'blobs') -Destination (Join-Path $outside 'blobsdir2') -Recurse; Remove-Item -LiteralPath (Join-Path $d 'blobs') -Recurse; New-Link -Path (Join-Path $d 'blobs') -Target (Join-Path $outside 'blobsdir2')
        $rej = Test-RunDirectory -Path $d -RequireMarker -Bounded -RejectReparsePoints
        Test-Case 'links: a blobs directory that is a symbolic link is refused as reparse_point' (Test-BoundFailure $rej 'reparse_point') (Get-FailCode $rej)
        Remove-Links
        $d = New-SynthRun; [IO.File]::WriteAllText((Join-Path $outside 'stray.txt'), 'z'); New-Link -Path (Join-Path $d 'stray.txt') -Target (Join-Path $outside 'stray.txt')
        $rej = Test-RunDirectory -Path $d -RequireMarker -Bounded -RejectReparsePoints
        Test-Case 'links: an unlisted link in the Run is refused as reparse_point, not just reported as unlisted' (Test-BoundFailure $rej 'reparse_point') (Get-FailCode $rej)
        Remove-Links
        $holder = New-TempDir; $real = New-SynthRun -Name 'run' -Parent $holder; $jroot = Join-Path (New-TempDir) 'jrun'; New-Link -Path $jroot -Target $real -Junction
        $rej = Test-RunDirectory -Path $jroot -RequireMarker -Bounded -RejectReparsePoints
        $acc = Test-RunDirectory -Path $real -RequireMarker -Bounded -RejectReparsePoints
        Test-Case 'links: a root that is a junction is refused as reparse_point (the real directory is accepted)' ((Test-BoundFailure $rej 'reparse_point') -and $acc.Result -ceq 'success') "$(Get-FailCode $rej) / $($acc.Result)"
        Remove-Links
        $holder = New-TempDir; $null = New-SynthRun -Name 'run' -Parent $holder; $anc = Join-Path (New-TempDir) 'anc'; New-Link -Path $anc -Target $holder -Junction
        $rej = Test-RunDirectory -Path (Join-Path $anc 'run') -RequireMarker -Bounded -RejectReparsePoints
        $okAnc = Test-RunDirectory -Path (Join-Path $anc 'run') -RequireMarker -Bounded
        Test-Case 'links: an ancestor of the root that is a junction is refused as reparse_point' (Test-BoundFailure $rej 'reparse_point') (Get-FailCode $rej)
        Test-Case 'links: without -RejectReparsePoints an ancestor junction is not looked at (documented limit)' ($okAnc.Result -ceq 'success')
        Remove-Links
        $d = New-SynthRun; $rp = Join-Path $d 'records.jsonl'; Remove-Item -LiteralPath $rp; [void][IO.Directory]::CreateDirectory($rp)
        $rej = Test-RunDirectory -Path $d -RequireMarker -Bounded -RejectReparsePoints
        Test-Case 'path: a directory where records.jsonl must be a file is refused (path_unsafe)' (Test-BoundFailure $rej 'path_unsafe') (Get-FailCode $rej)
        foreach ($case in @('blobs/NUL', 'blobs/con.txt', 'blobs/a:stream', 'blobs/dot.', 'blobs/space ')) {
            $d = New-SynthRun; $mp = Join-Path $d 'manifest.json'; $m = ConvertFrom-JsonStrict -Text ([IO.File]::ReadAllText($mp).TrimEnd("`n"))
            $m['artifacts'].Add([ordered]@{ path = $case; sha256 = (Get-Sha256Hex -Bytes ([byte[]]@())) }); [IO.File]::WriteAllBytes($mp, $utf8.GetBytes((ConvertTo-CanonicalJson -Value $m) + "`n")); Set-Marker $d
            $r = Test-RunDirectory -Path $d -RequireMarker -Bounded
            Test-Case "path: the artifact path '$case' (device name, stream, trailing dot or space) is refused in the bounded mode (path_unsafe)" (Test-BoundFailure $r 'path_unsafe') (Get-FailCode $r)
        }
        $r = Test-RunDirectory -Path ($baseRun + [char]0 + 'x') -RequireMarker -Bounded
        Test-Case 'path: a path with a NUL character is refused (path_unsafe)' (Test-BoundFailure $r 'path_unsafe') (Get-FailCode $r)
        $r = Test-RunDirectory -Path (Join-Path (New-TempDir) 'does-not-exist') -RequireMarker -Bounded -RejectReparsePoints
        Test-Case 'path: a Run directory that does not exist is no_manifest, as before' ($r.Incomplete -and $r.IncompleteReason -ceq 'no_manifest')
        $r = Test-RunDirectory -Path (($baseRun -replace '\\', '/') + '/') -RequireMarker -Bounded -RejectReparsePoints
        Test-Case 'path: forward slashes and a trailing separator in the root are normalized and accepted' ($r.Result -ceq 'success')

        # ---- reuse of the verified data (what part B3b may take without reading the Run again)
        $vd = Test-RunDirectory -Path $baseRun -RequireMarker -Bounded -RejectReparsePoints -IncludeVerifiedData
        $v = $vd.VerifiedData
        Test-Case 'reuse: manifest, COMPLETE and records.jsonl are each opened once, and the one blob once' ($v.ReadCounts.manifest -eq 1 -and $v.ReadCounts.complete -eq 1 -and $v.ReadCounts.records -eq 1 -and $v.ReadCounts.artifact -eq 1) ($v.ReadCounts | ConvertTo-Json -Compress)
        Test-Case 'reuse: the manifest hash equals the independent hash of the manifest file and the Result field' ($v.ManifestSha256 -ceq (Get-FileHash -LiteralPath (Join-Path $baseRun 'manifest.json') -Algorithm SHA256).Hash.ToLowerInvariant() -and $v.ManifestSha256 -ceq $vd.ManifestSha256 -and $v.MarkerMatchesManifest -eq $true)
        $indep = ConvertFrom-JsonStrict -Text ([IO.File]::ReadAllText((Join-Path $baseRun 'manifest.json')).TrimEnd("`n"))
        Test-Case 'reuse: the manifest in the verified data is the manifest of the verified bytes (canonical forms equal)' ((ConvertTo-CanonicalJson -Value $v.Manifest) -ceq (ConvertTo-CanonicalJson -Value $indep))
        $listedRecords = @($v.Manifest['artifacts'] | Where-Object { $_['path'] -ceq 'records.jsonl' })[0]['sha256']
        Test-Case 'reuse: the records bytes handed over are the bytes whose hash the manifest lists (hashing and parsing share one read)' ((Get-Sha256Hex -Bytes $v.RecordsBytes) -ceq $listedRecords -and [System.Linq.Enumerable]::SequenceEqual([byte[]]$v.RecordsBytes, [IO.File]::ReadAllBytes((Join-Path $baseRun 'records.jsonl'))))
        $lines = @($utf8.GetString($v.RecordsBytes).TrimEnd("`n").Split("`n"))
        $lastRec = ConvertFrom-JsonStrict -Text $lines[$lines.Count - 1]
        Test-Case 'reuse: the last record parsed from the handed-over bytes carries the chain hash of the manifest' ($lastRec['hash'] -ceq $v.Manifest['chain']['lastHash'] -and [long]$v.Manifest['chain']['records'] -eq $lines.Count)
        $d = New-SynthRun; $bf = @(Get-ChildItem -LiteralPath (Join-Path $d 'blobs') -File)[0]; $bb = [IO.File]::ReadAllBytes($bf.FullName); $bb[0] = $bb[0] -bxor 1; [IO.File]::WriteAllBytes($bf.FullName, $bb)
        $r = Test-RunDirectory -Path $d -RequireMarker -Bounded -IncludeVerifiedData
        Test-Case 'reuse: a failed verification (modified artifact) has the property VerifiedData and it is $null' ($r.Result -ceq 'failure' -and $r.PSObject.Properties.Name -contains 'VerifiedData' -and $null -eq $r.VerifiedData)
        $d = New-SynthRun; [IO.File]::WriteAllText((Join-Path $d 'COMPLETE'), ('0' * 64))
        $r = Test-RunDirectory -Path $d -RequireMarker -Bounded -IncludeVerifiedData
        Test-Case 'reuse: a COMPLETE that differs from the manifest hash gives no verified data, although the verification result is success' ($r.Result -ceq 'success' -and $null -eq $r.VerifiedData)
        $r = Test-RunDirectory -Path $baseRun -RequireMarker -Bounded -MaxTotalBytes 10 -IncludeVerifiedData
        Test-Case 'reuse: a bound failure gives no verified data' ((Test-BoundFailure $r 'budget_exceeded') -and $null -eq $r.VerifiedData)
        $r = Test-RunDirectory -Path $baseRun -RequireMarker -Bounded
        Test-Case 'reuse: without -IncludeVerifiedData the result has no VerifiedData property' (-not ($r.PSObject.Properties.Name -contains 'VerifiedData'))
        $all = @(& { Test-RunDirectory -Path $baseRun -RequireMarker -Bounded -IncludeVerifiedData } *>&1)
        Test-Case 'reuse: the call writes one object to the pipeline and nothing to any other stream (no console output of manifest or records)' ($all.Count -eq 1 -and $all[0] -isnot [string] -and $all[0].Result -ceq 'success')

        # ---- read-only and cleanup
        $before = Get-Snapshot -Dir $baseRun
        $null = Test-RunDirectory -Path $baseRun -RequireMarker -Bounded -RejectReparsePoints -IncludeVerifiedData
        $null = Test-RunDirectory -Path $baseRun -RequireMarker -Bounded -MaxTotalBytes 10
        Test-Case 'readonly: the file list, sizes, SHA-256 and modification times of the Run are unchanged after a success and after a failed bound' ($before -ceq (Get-Snapshot -Dir $baseRun))
        $d = New-SynthRun; $null = Test-RunDirectory -Path $d -RequireMarker -Bounded -MaxTotalBytes 100
        $removed = $true; try { Remove-Item -LiteralPath $d -Recurse -Force -ErrorAction Stop } catch { $removed = $false }
        Test-Case 'cleanup: after a verification that stopped at the budget no handle is left open (the directory can be removed)' ($removed -and -not (Test-Path -LiteralPath $d))
        $src = [IO.File]::ReadAllText((Join-Path $script:ToolsDir 'DiscoveryCommon.psm1'))
        $i0 = $src.IndexOf('# Bounded verification support'); $i1 = $src.IndexOf('function Add-BlobRefs')
        $newPart = $src.Substring($i0, [Math]::Max(0, $i1 - $i0))
        $iv0 = $src.IndexOf('function Invoke-RunDirectoryVerification'); $iv1 = $src.IndexOf('# The acceptance rule of a completed Run directory')
        $verifyPart = $src.Substring($iv0, $iv1 - $iv0)
        Test-Case 'static: the bounded helpers contain no write, delete, move, create, or copy call' ($i0 -ge 0 -and $i1 -gt $i0 -and $newPart -notmatch 'WriteAll|Set-Content|Out-File|New-Item|Remove-Item|Move-Item|Copy-Item|Add-Content|FileMode\]::Create|FileAccess\]::Write|\.Delete\(|CreateDirectory')
        Test-Case 'static: the module as a whole opens no file for writing' ($src -notmatch 'FileAccess\]::Write|FileAccess\]::ReadWrite|FileMode\]::Create|WriteAll|Set-Content|Out-File')
        Test-Case 'static: the enumeration is lazy and counted in the walk (no Get-ChildItem, no Get-RelativeFiles, no -Recurse in the bounded walk)' ($newPart -match 'function Get-RunFilesBounded' -and ($newPart.Substring($newPart.IndexOf('function Get-RunFilesBounded'))) -notmatch 'Get-ChildItem|Get-RelativeFiles|RecurseSubdirectories = \$true|-Recurse' -and $newPart -match 'EnumerateFileSystemInfos')
        # AST judge: file reads that bypass Read-RunFile inside one function. Comments and strings are not code, so they are not matched.
        # Limit: a dynamic call (& $name, Invoke-Expression, reflection, a method name held in a variable) is not detected.
        $readJudge = {
            param([string]$Code, [string]$FunctionName)
            $tk = $null; $er = $null
            $ast = [System.Management.Automation.Language.Parser]::ParseInput($Code, [ref]$tk, [ref]$er)
            if (@($er).Count -gt 0) { return @('(parse error)') }
            $fn = @($ast.FindAll({ param($n) $n -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -ieq $FunctionName }, $true))
            if ($fn.Count -ne 1) { return @('(function not found)') }
            $methods = 'ReadAllBytes', 'ReadAllText', 'ReadAllLines', 'ReadLines', 'OpenRead', 'OpenText', 'Open'
            $commands = 'Get-Content', 'Get-Sha256HexOfFile', 'Get-FileHash', 'Import-Csv', 'Select-String'
            $hits = [System.Collections.Generic.List[string]]::new()
            foreach ($n in $fn[0].Body.FindAll({ param($x) $x -is [System.Management.Automation.Language.InvokeMemberExpressionAst] -or $x -is [System.Management.Automation.Language.CommandAst] }, $true)) {
                if ($n -is [System.Management.Automation.Language.InvokeMemberExpressionAst]) {
                    $m = if ($n.Member -is [System.Management.Automation.Language.StringConstantExpressionAst]) { $n.Member.Value } else { '(dynamic member)' }
                    if ($methods -icontains $m -or $m -eq '(dynamic member)') { $hits.Add("method $m") }
                } else {
                    $c = $n.GetCommandName()
                    if ($null -ne $c -and $commands -icontains $c) { $hits.Add("command $c") }
                }
            }
            , $hits.ToArray()
        }
        $readHits = & $readJudge $src 'Invoke-RunDirectoryVerification'
        Test-Case 'static: the verification reads files only through Read-RunFile (AST: no ReadAllBytes, ReadAllText, Open, Get-Content, Get-Sha256HexOfFile, Get-FileHash call in Invoke-RunDirectoryVerification, which both modes use)' (@($readHits).Count -eq 0) (@($readHits) -join ',')
        $hc = & $readJudge "function Invoke-RunDirectoryVerification {`n    # the decoding of File.ReadAllText and Get-Content`n    `$x = 'ReadAllBytes'`n    Read-RunFile -Path `$p`n}" 'Invoke-RunDirectoryVerification'
        Test-Case 'static judge (negative control): a forbidden name in a comment or a string is not reported' (@($hc).Count -eq 0) (@($hc) -join ',')
        $hm = & $readJudge "function Invoke-RunDirectoryVerification {`n    `$b = [System.IO.File]::ReadAllText(`$p)`n}" 'Invoke-RunDirectoryVerification'
        Test-Case 'static judge (negative control): a real ReadAllText method call is reported' (@($hm) -contains 'method ReadAllText') (@($hm) -join ',')
        $hg = & $readJudge "function Invoke-RunDirectoryVerification {`n    `$b = get-content -LiteralPath `$p -Raw`n}" 'Invoke-RunDirectoryVerification'
        Test-Case 'static judge (negative control): a real Get-Content command call (any letter case) is reported' (@($hg) -contains 'command get-content') (@($hg) -join ',')
        $rs = $newPart.Substring($newPart.IndexOf('function Read-RunStream'), $newPart.IndexOf('function Read-RunFile') - $newPart.IndexOf('function Read-RunStream')) -replace '\$buf\.Length', ''
        Test-Case 'static: the stream reader never asks the stream for its length, position, or a seek' ($rs -notmatch '\.Length|\.Position|\.Seek|Get-Item|FileInfo')
        Test-Case 'static: every file handle is closed in a finally block' ($newPart -match 'finally \{ if \(\$null -ne \$fs\) \{ \$fs\.Dispose\(\) \} \}')
        Test-Case 'static: the defaults are 64 MiB, 4 MiB, 128 bytes, 10000 entries, and depth 16' ($newPart -match '64 \* 1024 \* 1024' -and $newPart -match '4 \* 1024 \* 1024' -and $newPart -match 'MaxMarkerBytes   = \[long\]128' -and $newPart -match 'MaxEntries       = \[long\]10000' -and $newPart -match 'MaxDepth         = \[long\]16')
        $launcher = [IO.File]::ReadAllText((Join-Path $script:ToolsDir 'DiscoveryLauncher.psm1'))
        # AST judge: calls of the Run verification and the bounded options passed to them. A parameter token is reported when it is a
        # case-insensitive prefix of a bounded option (PowerShell accepts unique abbreviations), and a splatted argument is reported because its
        # content is not known statically. Limit: a call through & with a string or a variable, Invoke-Expression, or a scriptblock built at
        # run time is not seen.
        $boundedOptions = 'Bounded', 'MaxTotalBytes', 'MaxManifestBytes', 'MaxMarkerBytes', 'MaxEntries', 'MaxDepth', 'RejectReparsePoints', 'IncludeVerifiedData'
        $optJudge = {
            param([string]$Code)
            $tk = $null; $er = $null
            $ast = [System.Management.Automation.Language.Parser]::ParseInput($Code, [ref]$tk, [ref]$er)
            $calls = [System.Collections.Generic.List[object]]::new()
            foreach ($c in $ast.FindAll({ param($n) $n -is [System.Management.Automation.Language.CommandAst] }, $true)) {
                $name = $c.GetCommandName()
                if ($null -eq $name -or @('Test-RunDirectory', 'Test-CompletedRun', 'Invoke-RunDirectoryVerification') -inotcontains $name) { continue }
                $bad = [System.Collections.Generic.List[string]]::new()
                foreach ($e in $c.CommandElements) {
                    if ($e -is [System.Management.Automation.Language.CommandParameterAst]) {
                        $pn = $e.ParameterName
                        foreach ($o in $boundedOptions) { if ($pn.Length -gt 0 -and $o.StartsWith($pn, [StringComparison]::OrdinalIgnoreCase)) { $bad.Add("-$pn"); break } }
                    } elseif ($e -is [System.Management.Automation.Language.VariableExpressionAst] -and $e.Splatted) { $bad.Add("@$($e.VariablePath.UserPath)") }
                }
                $calls.Add([pscustomobject]@{ Name = $name; Line = $c.Extent.StartLineNumber; Bad = $bad.ToArray() })
            }
            [pscustomobject]@{ ParseErrors = @($er).Count; Calls = $calls.ToArray() }
        }
        $lj = & $optJudge $launcher
        $lLines = (@($lj.Calls | ForEach-Object { $_.Line }) -join ',')
        Test-Case 'compat: the AST judge finds exactly the five existing Run verification calls of the Launcher (lines 464, 626, 635, 636, 833)' ($lj.ParseErrors -eq 0 -and $lLines -ceq '464,626,635,636,833') "lines=$lLines"
        $lBad = @($lj.Calls | Where-Object { $_.Bad.Count -gt 0 } | ForEach-Object { "$($_.Line):$($_.Bad -join '/')" })
        Test-Case 'compat: the Launcher passes no bounded option to Test-RunDirectory or Test-CompletedRun (AST: no parameter that abbreviates a bounded option, no splatting; its calls are the existing ones)' ($lBad.Count -eq 0) ($lBad -join ',')
        $jn = & $optJudge "Invoke-BoundedProcess -FileName 'docker' -Arguments `$a`n`$script:BoundedSource = 'x'"
        Test-Case 'static judge (negative control): the function name Invoke-BoundedProcess is not reported' (@($jn.Calls).Count -eq 0)
        $jb = & $optJudge "`$v = Test-RunDirectory -Path `$p -Bounded"
        Test-Case 'static judge (negative control): -Bounded given to Test-RunDirectory is reported' (@($jb.Calls).Count -eq 1 -and $jb.Calls[0].Bad -contains '-Bounded')
        $ja = & $optJudge "if (test-completedrun -Path `$p -bou) { }"
        Test-Case 'static judge (negative control): an abbreviated option in another letter case (-bou on test-completedrun) is reported' (@($ja.Calls).Count -eq 1 -and $ja.Calls[0].Bad -contains '-bou')
        $js = & $optJudge "`$v = Test-RunDirectory @splat"
        Test-Case 'static judge (negative control): a splatted argument list is reported (its content is unknown)' (@($js.Calls).Count -eq 1 -and $js.Calls[0].Bad -contains '@splat')
        $jc = & $optJudge "# Test-RunDirectory -Path `$p -Bounded`n`$t = 'Test-RunDirectory -Bounded'"
        Test-Case 'static judge (negative control): the option in a comment or a string is not reported' (@($jc.Calls).Count -eq 0)
        Test-Case 'compat: the module exports exactly the existing functions (no new export)' ($src -match 'Export-ModuleMember -Function Get-Sha256Hex, Get-Sha256HexOfText, Get-Sha256HexOfFile, ConvertTo-CanonicalJson, ConvertFrom-JsonStrict, Test-CanonicalText, Get-CodePointCount, Test-HasNonJsWhitespace, Test-SafeRelativePath, Test-RunDirectory, Test-CompletedRun\r?\n?$')
    } finally { Remove-Links }
}
