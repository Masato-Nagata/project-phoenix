#Requires -Version 7.0
# Tests of the Approval_Store writer (task 2.25): golden vectors in both directions, every refusal, the hash chain, the store-layer
# interface, the command, concurrency, and the static checks. Temporary stores only: discovery/approvals/ is never read or written
# and no real Approval_Record is created. In-process tests use a test-specific store mutex name.
. (Join-Path $PSScriptRoot 'lib/testlib.ps1')
Import-Module (Join-Path $script:ToolsDir 'DiscoveryCommon.psm1') -Force -DisableNameChecking
Import-Module (Join-Path $script:ToolsDir 'ApprovalStore.psm1') -Force -DisableNameChecking

$vectorDir = Join-Path $script:RepoRoot 'packages/discovery-loop/test-vectors/approval'
$utf8 = [System.Text.UTF8Encoding]::new($false)
$mutexName = 'Local\PhoenixTest-ApprovalStore-' + [guid]::NewGuid().ToString('N')
$addCommand = Join-Path $script:ToolsDir 'Add-ApprovalRecord.ps1'
$harness = Join-Path $PSScriptRoot 'ApprovalStoreRequestHarness.ps1'

function Read-Vectors { param([string]$Name) ConvertFrom-JsonStrict -Text ([IO.File]::ReadAllText((Join-Path $vectorDir $Name), $utf8)) }
function Get-Hex { param([byte[]]$B) [Convert]::ToHexString($B).ToLowerInvariant() }
function Sort-Ordinal { param([string[]]$Names) $a = [string[]]@($Names); [Array]::Sort($a, [StringComparer]::Ordinal); , $a }
function New-Store { param([string]$Dir, [string]$Text = '') $p = Join-Path $Dir 'approvals.jsonl'; [IO.File]::WriteAllBytes($p, $utf8.GetBytes($Text)); $p }
function Invoke-Req { param([string]$Store, $Request, [scriptblock]$Resolver) Invoke-ApprovalStoreRequest -StorePath $Store -Request $Request -MutexName $mutexName -TargetResolver $Resolver }
function New-Candidate {
    param([hashtable]$Over = @{}, [string[]]$Without = @())
    $c = [ordered]@{ approver = 'Test Approver'; timestamp = '2025-03-04T05:06:07.000+09:00'; target = [ordered]@{ kind = 'gate'; gate_id = 'container-runtime' }; decision = 'approved'; rationale = 'Test rationale.'; recorded_by = 'human' }
    foreach ($k in $Over.Keys) { $c[$k] = $Over[$k] }
    foreach ($k in $Without) { $c.Remove($k) }
    $c
}
function Get-LineTexts { param([string]$Path) @([IO.File]::ReadAllText($Path, $utf8).Split("`n") | Where-Object { $_ -ne '' }) }

Invoke-TestMain {
    Write-Host '=== Approval_Store (task 2.25) ===' -ForegroundColor Cyan

    # ---- golden vectors, both directions (valid chains)
    $valid = Read-Vectors 'valid-chains.json'
    foreach ($case in $valid['cases']) {
        $name = $case['name']
        $forward = $true; $detail = ''
        $text = ''
        foreach ($l in $case['lines']) {
            $canon = ConvertTo-CanonicalJson -Value $l['fields']
            if ($canon -cne $l['hashInput']) { $forward = $false; $detail = "hashInput differs at seq $($l['seq'])" }
            $bytes = $utf8.GetBytes($canon)
            if ((Get-Hex $bytes) -cne $l['hashInputHex']) { $forward = $false; $detail = "hashInputHex differs at seq $($l['seq'])" }
            if ((Get-Sha256Hex -Bytes $bytes) -cne $l['hash']) { $forward = $false; $detail = "hash differs at seq $($l['seq'])" }
            $full = [ordered]@{}; foreach ($k in $l['fields'].Keys) { $full[$k] = $l['fields'][$k] }; $full['hash'] = $l['hash']
            if ((ConvertTo-CanonicalJson -Value $full) -cne $l['line']) { $forward = $false; $detail = "line differs at seq $($l['seq'])" }
            $text += $l['line'] + "`n"
        }
        if ($text -cne $case['storeText']) { $forward = $false; $detail = 'storeText differs' }
        if ((Get-Hex $utf8.GetBytes($text)) -cne $case['storeTextUtf8Hex']) { $forward = $false; $detail = 'storeTextUtf8Hex differs' }
        Test-Case "golden/forward: PowerShell reproduces the canonical bytes and hashes of '$name'" $forward $detail
        $a = Get-ApprovalStoreAnalysis -Bytes $utf8.GetBytes($case['storeText'])
        Test-Case "golden/verify: '$name' verifies without finding" $a.Ok "mismatches=$($a.Mismatches.Count) violations=$($a.RuleViolations.Count)"

        # backward: the writer builds the same store line by line
        $dir = New-TempDir
        $store = New-Store $dir ''
        $backward = $true; $detail = ''
        $resolver = { param($t) switch ($t['kind']) { 'run' { $t['run_id'] -ceq 'run-0001' } 'claim_revision' { $t['run_id'] -ceq 'run-0001' -and $t['claim_revision_id'] -ceq 'clm-0001-r1' } default { $true } } }
        foreach ($l in $case['lines']) {
            if ($l['fields']['type'] -ceq 'approval') {
                $cand = [ordered]@{}
                foreach ($k in $l['fields'].Keys) { if ($k -cnotin 'type', 'seq', 'prev_hash') { $cand[$k] = $l['fields'][$k] } }
                $r = Invoke-Req $store ([ordered]@{ operation = 'append'; candidate = $cand }) $resolver
                if ($r.Outcome -ne 'stored') { $backward = $false; $detail = "append refused at seq $($l['seq']): $($r.Outcome)"; break }
                $got = (ConvertTo-StoredLineText -Line $r.Line).TrimEnd("`n")
                if ($got -cne $l['line']) { $backward = $false; $detail = "writer line differs at seq $($l['seq'])" }
            } else {
                # the vector's own rejection line (its reason text is not one of the fixed reasons of the store layer): appended as data
                $fs = [IO.File]::Open($store, [IO.FileMode]::Append); $b = $utf8.GetBytes($l['line'] + "`n"); $fs.Write($b, 0, $b.Length); $fs.Dispose()
            }
        }
        $final = [IO.File]::ReadAllText($store, $utf8)
        Test-Case "golden/backward: the writer reproduces the store of '$name' byte for byte" ($backward -and $final -ceq $case['storeText']) $detail
    }

    # ---- golden vectors: candidate validation
    $cv = Read-Vectors 'candidate-validation.json'
    $known = @($cv['context']['knownRuns'])
    $knownClaims = @($cv['context']['knownClaimRevisions'])
    $vres = {
        param($t)
        switch ($t['kind']) {
            'run' { $known -ccontains $t['run_id'] }
            'claim_revision' { [bool]@($knownClaims | Where-Object { $_['run_id'] -ceq $t['run_id'] -and $_['claim_revision_id'] -ceq $t['claim_revision_id'] }).Count }
            default { $true }
        }
    }
    $baseText = $cv['context']['storeText']
    foreach ($case in $cv['cases']) {
        $dir = New-TempDir
        $store = New-Store $dir $baseText
        $before = Get-FileBytesOrEmpty $store
        $r = Invoke-Req $store ([ordered]@{ operation = 'append'; candidate = $case['candidate'] }) $vres
        $expected = Sort-Ordinal @($case['expectedFields'])
        $got = Sort-Ordinal @(@($r.Issues) | ForEach-Object { $_.Field } | Select-Object -Unique)
        $ok = (($expected -join '|') -ceq ($got -join '|'))
        if ($expected.Count -eq 0) { $ok = $ok -and $r.Outcome -eq 'stored' }
        else { $ok = $ok -and $r.Outcome -eq 'invalid' -and (Test-BytesEqual $before (Get-FileBytesOrEmpty $store)) }
        Test-Case "golden/candidate: $($case['name'])" $ok "expected=[$($expected -join ',')] got=[$($got -join ',')] outcome=$($r.Outcome)"
    }

    # ---- golden vectors: tamper cases
    $tv = Read-Vectors 'tamper-cases.json'
    foreach ($case in $tv['cases']) {
        $anchor = if ($case.Contains('anchor')) { $case['anchor'] } else { $null }
        $a = Get-ApprovalStoreAnalysis -Bytes $utf8.GetBytes($case['storeText']) -Anchor $anchor
        $gotM = @($a.Mismatches | ForEach-Object { "$($_.Seq):$($_.Kind)" }) -join ','
        $expM = @($case['expectedMismatches'] | ForEach-Object { "$($_['seq']):$($_['kind'])" }) -join ','
        $gotV = @($a.RuleViolations | ForEach-Object { "$($_.Seq):$($_.Rule)" }) -join ','
        $expV = @($case['expectedRuleViolations'] | ForEach-Object { "$($_['seq']):$($_['rule'])" }) -join ','
        Test-Case "golden/tamper: $($case['name'])" (($a.Ok -eq $case['expectedOk']) -and $gotM -ceq $expM -and $gotV -ceq $expV) "ok=$($a.Ok) mismatches=[$gotM] expected=[$expM] violations=[$gotV] expected=[$expV]"
    }
    # ---- the operation table of the store layer (in process)
    $dir = New-TempDir
    $store = New-Store $dir ''
    $r1 = Invoke-Req $store ([ordered]@{ operation = 'append'; candidate = (New-Candidate) })
    $r2 = Invoke-Req $store ([ordered]@{ operation = 'append'; candidate = (New-Candidate -Over @{ target = [ordered]@{ kind = 'gate'; gate_id = 'override-apply' }; decision = 'needs_changes' }) })
    Test-Case 'append: a valid record is stored with seq 1, 2 and a genesis predecessor' ($r1.Outcome -eq 'stored' -and $r1.Line['seq'] -eq 1 -and $r1.Line['prev_hash'] -ceq ('0' * 64) -and $r2.Line['seq'] -eq 2 -and $r2.Line['prev_hash'] -ceq $r1.Line['hash'])
    Test-Case 'append: the stored chain verifies' (Test-ApprovalStore -StorePath $store).Ok
    $before = Get-FileBytesOrEmpty $store
    $rm = Invoke-Req $store ([ordered]@{ operation = 'modify'; attempted_seq = 1; candidate = (New-Candidate -Over @{ rationale = 'changed' }) })
    $after = Get-FileBytesOrEmpty $store
    $lines = @(Get-LineTexts $store)
    $prefixKept = Test-BytesEqual $before ([byte[]]$after[0..($before.Length - 1)])
    $last = ConvertFrom-JsonStrict -Text $lines[-1]
    Test-Case 'modify: refused, exactly one store_rejection line appended with modify_refused and attempted_seq, earlier lines unchanged' ($rm.Outcome -eq 'refused' -and $rm.ExitCode -ne 0 -and $lines.Count -eq 3 -and $prefixKept -and $last['type'] -ceq 'store_rejection' -and $last['reason'] -ceq 'modify_refused' -and $last['attempted_seq'] -eq 1)
    $rd = Invoke-Req $store ([ordered]@{ operation = 'delete'; attempted_seq = 77 })
    $last = ConvertFrom-JsonStrict -Text (@(Get-LineTexts $store)[-1])
    Test-Case 'delete: refused with delete_refused; an attempted_seq that does not exist is not recorded' ($rd.Outcome -eq 'refused' -and $last['reason'] -ceq 'delete_refused' -and -not $last.Contains('attempted_seq') -and @(Get-LineTexts $store).Count -eq 4)
    Test-Case 'a rejection line carries nothing from the request' (-not (@(Get-LineTexts $store)[-2]).Contains('changed'))
    Test-Case 'the chain still verifies after the rejection lines, and they do not change any Gate status' ((Test-ApprovalStore -StorePath $store).Ok -and (Get-ApprovalGateStatus -StorePath $store -GateId 'container-runtime').Status -eq 'approved')
    $before = Get-FileBytesOrEmpty $store
    foreach ($op in @('update', 'APPEND', '', $null, 5)) {
        $ru = Invoke-Req $store ([ordered]@{ operation = $op; candidate = (New-Candidate) })
        Test-Case "an unknown operation '$op' changes nothing" ($ru.Outcome -eq 'invalid' -and (Test-BytesEqual $before (Get-FileBytesOrEmpty $store)))
    }
    $ru = Invoke-Req $store 'not a request'
    Test-Case 'a request that is not an object changes nothing' ($ru.Outcome -eq 'invalid' -and (Test-BytesEqual $before (Get-FileBytesOrEmpty $store)))

    # ---- run: and claim: targets are unresolvable in part 1
    foreach ($tg in @([ordered]@{ kind = 'run'; run_id = 'run-0001' }, [ordered]@{ kind = 'claim_revision'; run_id = 'run-0001'; claim_revision_id = 'clm-0001-r1' })) {
        $before = Get-FileBytesOrEmpty $store
        $rr = Invoke-Req $store ([ordered]@{ operation = 'append'; candidate = (New-Candidate -Over @{ target = $tg }) })
        Test-Case "a $($tg['kind']) target is rejected as unresolvable and the store is byte-identical" ($rr.Outcome -eq 'invalid' -and @($rr.Issues | Where-Object { $_.Code -eq 'unresolved_target' }).Count -eq 1 -and (Test-BytesEqual $before (Get-FileBytesOrEmpty $store)))
    }

    # ---- supersedes
    $dir = New-TempDir
    $store = New-Store $dir ''
    $a1 = Invoke-Req $store ([ordered]@{ operation = 'append'; candidate = (New-Candidate -Over @{ target = [ordered]@{ kind = 'gate'; gate_id = 'override-apply' } }) })
    $a2 = Invoke-Req $store ([ordered]@{ operation = 'append'; candidate = (New-Candidate -Over @{ target = [ordered]@{ kind = 'gate'; gate_id = 'override-apply' }; decision = 'rejected'; supersedes = [long]1 }) })
    Test-Case 'supersedes: a withdrawal of the latest record of the same target is accepted, and the status follows it' ($a2.Outcome -eq 'stored' -and (Get-ApprovalGateStatus -StorePath $store -GateId 'override-apply').Status -eq 'rejected')
    $before = Get-FileBytesOrEmpty $store
    $a3 = Invoke-Req $store ([ordered]@{ operation = 'append'; candidate = (New-Candidate -Over @{ target = [ordered]@{ kind = 'gate'; gate_id = 'override-apply' }; supersedes = [long]1 }) })
    $a4 = Invoke-Req $store ([ordered]@{ operation = 'append'; candidate = (New-Candidate -Over @{ supersedes = [long]2 }) })
    $a5 = Invoke-Req $store ([ordered]@{ operation = 'append'; candidate = (New-Candidate -Over @{ supersedes = [long]9 }) })
    Test-Case 'supersedes: an already superseded record, another target, and an unknown record are rejected, byte-identical' (
        @($a3.Issues | Where-Object Code -eq 'supersedes_already_superseded').Count -eq 1 -and
        @($a4.Issues | Where-Object Code -eq 'supersedes_target_differs').Count -eq 1 -and
        @($a5.Issues | Where-Object Code -eq 'supersedes_unknown').Count -eq 1 -and
        (Test-BytesEqual $before (Get-FileBytesOrEmpty $store)))

    # ---- a damaged chain is reported and not extended
    $dir = New-TempDir
    $good = New-Store $dir ''
    [void](Invoke-Req $good ([ordered]@{ operation = 'append'; candidate = (New-Candidate) }))
    [void](Invoke-Req $good ([ordered]@{ operation = 'append'; candidate = (New-Candidate -Over @{ decision = 'rejected' }) }))
    $text = [IO.File]::ReadAllText($good, $utf8)
    [IO.File]::WriteAllText($good, $text.Replace('Test rationale.', 'Edited rationale'), $utf8)
    $before = Get-FileBytesOrEmpty $good
    $bad = @(
        (Invoke-Req $good ([ordered]@{ operation = 'append'; candidate = (New-Candidate) })),
        (Invoke-Req $good ([ordered]@{ operation = 'modify'; attempted_seq = 1 })),
        (Invoke-Req $good ([ordered]@{ operation = 'delete' }))
    )
    Test-Case 'append, modify and delete on a damaged chain write nothing and report store_invalid' ((@($bad | Where-Object Outcome -ne 'store_invalid').Count -eq 0) -and (Test-BytesEqual $before (Get-FileBytesOrEmpty $good)))
    $v = Test-ApprovalStore -StorePath $good
    Test-Case 'verify reports the edited line as modified with its seq' (-not $v.Ok -and @($v.Mismatches | Where-Object { $_.Seq -eq 1 -and $_.Kind -eq 'modified' }).Count -ge 1)

    # ---- the Launcher read function
    $dir = New-TempDir
    $empty = Join-Path $dir 'none.jsonl'
    $st = New-Store $dir ''
    [void](Invoke-Req $st ([ordered]@{ operation = 'append'; candidate = (New-Candidate -Over @{ target = [ordered]@{ kind = 'gate'; gate_id = 'override-apply' } }) }))
    $g1 = Get-ApprovalGateStatus -StorePath $st -GateId 'override-apply'
    $g2 = Get-ApprovalGateStatus -StorePath $st -GateId 'm6-start'
    $g3 = Get-ApprovalGateStatus -StorePath $empty -GateId 'override-apply'
    $g4 = Get-ApprovalGateStatus -StorePath $st -GateId 'no-such-gate'
    Test-Case 'gate status: approved on a valid store; none for a Gate without record, a missing store, and an unknown Gate' ($g1.Status -eq 'approved' -and $g1.Verified -and $g2.Status -eq 'none' -and $g3.Status -eq 'none' -and $g4.Status -eq 'none' -and $g4.Error -eq 'unknown_gate')
    [IO.File]::WriteAllText($st, ([IO.File]::ReadAllText($st, $utf8)).Replace('Test Approver', 'Other Approver'), $utf8)
    $g5 = Get-ApprovalGateStatus -StorePath $st -GateId 'override-apply'
    Test-Case 'gate status: a tampered store means no approval' ($g5.Status -eq 'none' -and -not $g5.Verified -and $g5.Error -eq 'verification_failed')
    Test-Case 'gate status: the note claims neither completeness nor authenticity' ($g1.Note -match 'completeness' -and $g1.Note -match 'not claimed')

    # ---- process-level tests: the command
    $dir = New-TempDir
    $store = New-Store $dir ''
    $ok = Invoke-ChildPwsh $addCommand @('-Approver', 'Proc Approver', '-Decision', 'approved', '-Target', 'gate:m6-start', '-Rationale', 'Process test.', '-Actor', 'human', '-StorePath', $store)
    $line = ConvertFrom-JsonStrict -Text (@(Get-LineTexts $store)[0])
    Test-Case 'command: stores a gate approval with exit 0, recorded_by as declared, and a host-clock timestamp with offset' ($ok.ExitCode -eq 0 -and $line['recorded_by'] -ceq 'human' -and $line['timestamp'] -cmatch '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}[+-]\d{2}:\d{2}$')
    $before = Get-FileBytesOrEmpty $store
    $cases = @(
        @{ Name = 'no actor'; Args = @('-Approver', 'A', '-Decision', 'approved', '-Target', 'gate:m6-start', '-Rationale', 'R.'); Field = 'recorded_by' },
        @{ Name = 'another actor'; Args = @('-Approver', 'A', '-Decision', 'approved', '-Target', 'gate:m6-start', '-Rationale', 'R.', '-Actor', 'robot'); Field = 'recorded_by' },
        @{ Name = 'no approver'; Args = @('-Decision', 'approved', '-Target', 'gate:m6-start', '-Rationale', 'R.', '-Actor', 'human'); Field = 'approver' },
        @{ Name = 'approver too long'; Args = @('-Approver', ('a' * 101), '-Decision', 'approved', '-Target', 'gate:m6-start', '-Rationale', 'R.', '-Actor', 'human'); Field = 'approver' },
        @{ Name = 'decision outside the set'; Args = @('-Approver', 'A', '-Decision', 'maybe', '-Target', 'gate:m6-start', '-Rationale', 'R.', '-Actor', 'human'); Field = 'decision' },
        @{ Name = 'no rationale'; Args = @('-Approver', 'A', '-Decision', 'approved', '-Target', 'gate:m6-start', '-Actor', 'human'); Field = 'rationale' },
        @{ Name = 'whitespace rationale'; Args = @('-Approver', 'A', '-Decision', 'approved', '-Target', 'gate:m6-start', '-Rationale', '   ', '-Actor', 'human'); Field = 'rationale' },
        @{ Name = 'rationale too long'; Args = @('-Approver', 'A', '-Decision', 'approved', '-Target', 'gate:m6-start', '-Rationale', ('x' * 2001), '-Actor', 'human'); Field = 'rationale' },
        @{ Name = 'no target'; Args = @('-Approver', 'A', '-Decision', 'approved', '-Rationale', 'R.', '-Actor', 'human'); Field = 'target' },
        @{ Name = 'undefined gate'; Args = @('-Approver', 'A', '-Decision', 'approved', '-Target', 'gate:no-such-gate', '-Rationale', 'R.', '-Actor', 'human'); Field = 'target' },
        @{ Name = 'run target'; Args = @('-Approver', 'A', '-Decision', 'approved', '-Target', 'run:run-0001', '-Rationale', 'R.', '-Actor', 'human'); Field = 'target' },
        @{ Name = 'claim target'; Args = @('-Approver', 'A', '-Decision', 'approved', '-Target', 'claim:run-0001/clm-0001-r1', '-Rationale', 'R.', '-Actor', 'human'); Field = 'target' },
        @{ Name = 'malformed target'; Args = @('-Approver', 'A', '-Decision', 'approved', '-Target', 'something', '-Rationale', 'R.', '-Actor', 'human'); Field = 'target' },
        @{ Name = 'supersedes unknown'; Args = @('-Approver', 'A', '-Decision', 'approved', '-Target', 'gate:m6-start', '-Rationale', 'R.', '-Actor', 'human', '-Supersedes', '99'); Field = 'supersedes' },
        @{ Name = 'supersedes not a number'; Args = @('-Approver', 'A', '-Decision', 'approved', '-Target', 'gate:m6-start', '-Rationale', 'R.', '-Actor', 'human', '-Supersedes', 'one'); Field = 'supersedes' }
    )
    foreach ($c in $cases) {
        $r = Invoke-ChildPwsh $addCommand ($c.Args + @('-StorePath', $store))
        Test-Case "command: $($c.Name) is refused, names '$($c.Field)', and leaves the store byte-identical" ($r.ExitCode -ne 0 -and $r.Error -match "invalid field: $($c.Field)" -and (Test-BytesEqual $before (Get-FileBytesOrEmpty $store))) "exit=$($r.ExitCode) err=$($r.Error.Trim())"
    }
    $two = Invoke-ChildPwsh $addCommand @('-Decision', 'maybe', '-Target', 'gate:m6-start', '-Actor', 'human', '-StorePath', $store)
    Test-Case 'command: several invalid fields are all named' ($two.Error -match 'invalid field: approver' -and $two.Error -match 'invalid field: decision' -and $two.Error -match 'invalid field: rationale')
    $ts = Invoke-ChildPwsh $addCommand @('-Approver', 'A', '-Decision', 'approved', '-Target', 'gate:m6-start', '-Rationale', 'R.', '-Actor', 'human', '-Timestamp', '2000-01-01T00:00:00Z', '-StorePath', $store)
    Test-Case 'command: there is no -Timestamp parameter' ($ts.ExitCode -ne 0 -and (Test-BytesEqual $before (Get-FileBytesOrEmpty $store)))
    $sup = Invoke-ChildPwsh $addCommand @('-Approver', 'A', '-Decision', 'rejected', '-Target', 'gate:m6-start', '-Rationale', 'Withdrawn.', '-Actor', 'kiro-development-agent', '-Supersedes', '1', '-StorePath', $store)
    Test-Case 'command: an accepted -Supersedes' ($sup.ExitCode -eq 0 -and @(Get-LineTexts $store).Count -eq 2)
    $vf = Invoke-ChildPwsh $addCommand @('-Verify', '-StorePath', $store)
    Test-Case 'command -Verify: exit 0 on a valid store, and it says that completeness is not claimed' ($vf.ExitCode -eq 0 -and $vf.Output -match 'not mean that the store is complete')
    $lines = @(Get-LineTexts $store)
    $tampers = @(
        @{ Name = 'modified'; Text = ($lines[0].Replace('Proc Approver', 'Proc Approvex') + "`n" + $lines[1] + "`n"); Kind = 'modified' },
        @{ Name = 'missing'; Text = ($lines[1] + "`n"); Kind = 'missing' },
        @{ Name = 'chain_break'; Text = ($lines[1] + "`n" + $lines[0] + "`n"); Kind = 'chain_break' }
    )
    foreach ($tc in $tampers) {
        $p = Join-Path (New-TempDir) 'approvals.jsonl'
        [IO.File]::WriteAllText($p, $tc.Text, $utf8)
        $before = Get-FileBytesOrEmpty $p
        $r = Invoke-ChildPwsh $addCommand @('-Verify', '-StorePath', $p)
        Test-Case "command -Verify detects $($tc.Name) with its seq, exits non-zero, and writes nothing" ($r.ExitCode -ne 0 -and $r.Error -match "kind $($tc.Kind)" -and (Test-BytesEqual $before (Get-FileBytesOrEmpty $p))) $r.Error.Trim()
    }
    $ap = Invoke-ChildPwsh $addCommand @('-Approver', 'A', '-Decision', 'approved', '-Target', 'gate:m6-start', '-Rationale', 'R.', '-Actor', 'human', '-StorePath', $p)
    Test-Case 'command: an append on a damaged chain writes nothing' ($ap.ExitCode -ne 0 -and $ap.Error -match 'store_invalid' -and (Test-BytesEqual $before (Get-FileBytesOrEmpty $p)))

    # ---- process-level tests: the test harness
    $dir = New-TempDir
    $store = New-Store $dir ''
    [void](Invoke-Req $store ([ordered]@{ operation = 'append'; candidate = (New-Candidate) }))
    $before = Get-FileBytesOrEmpty $store
    $reqPath = Join-Path $dir 'request.json'
    foreach ($op in @('modify', 'delete')) {
        [IO.File]::WriteAllText($reqPath, "{`"operation`":`"$op`",`"attempted_seq`":1}", $utf8)
        $prev = Get-FileBytesOrEmpty $store
        $r = Invoke-ChildPwsh $harness @('-StorePath', $store, '-RequestJsonPath', $reqPath)
        $now = Get-FileBytesOrEmpty $store
        $last = ConvertFrom-JsonStrict -Text (@(Get-LineTexts $store)[-1])
        Test-Case "harness: a $op request keeps every stored line and appends exactly one store_rejection line" ($r.ExitCode -ne 0 -and (Test-BytesEqual $prev ([byte[]]$now[0..($prev.Length - 1)])) -and $last['type'] -ceq 'store_rejection' -and $last['reason'] -ceq "${op}_refused")
    }
    [IO.File]::WriteAllText($reqPath, '{"operation":"append","candidate":{"approver":"","decision":"maybe","target":{"kind":"gate","gate_id":"m6-start"},"rationale":"R.","recorded_by":"human","timestamp":"2025-01-01T00:00:00Z"}}', $utf8)
    $prev = Get-FileBytesOrEmpty $store
    $r = Invoke-ChildPwsh $harness @('-StorePath', $store, '-RequestJsonPath', $reqPath)
    Test-Case 'harness: an invalid append leaves the whole file byte-identical' ($r.ExitCode -ne 0 -and (Test-BytesEqual $prev (Get-FileBytesOrEmpty $store)) -and $r.Error -match 'invalid field: approver' -and $r.Error -match 'invalid field: decision')
    [IO.File]::WriteAllText($reqPath, '{"operation":"rewrite"}', $utf8)
    $r = Invoke-ChildPwsh $harness @('-StorePath', $store, '-RequestJsonPath', $reqPath)
    Test-Case 'harness: an unknown operation changes nothing' ($r.ExitCode -ne 0 -and (Test-BytesEqual $prev (Get-FileBytesOrEmpty $store)))
    $realStore = Join-Path $script:RepoRoot 'discovery/approvals/approvals.jsonl'
    $existedBefore = Test-Path -LiteralPath $realStore
    $r = Invoke-ChildPwsh $harness @('-StorePath', $realStore, '-RequestJsonPath', $reqPath)
    Test-Case 'harness: refuses to write the real store' ($r.ExitCode -eq 3 -and (Test-Path -LiteralPath $realStore) -eq $existedBefore)

    # ---- concurrency: distinct seq and valid links (R23.13)
    $dir = New-TempDir
    $store = New-Store $dir ''
    $jobs = 1..6 | ForEach-Object {
        $i = $_
        Start-ThreadJob -ScriptBlock {
            param($cmd, $store, $i)
            $psi = [System.Diagnostics.ProcessStartInfo]::new((Get-Process -Id $PID).Path)
            foreach ($a in @('-NoProfile', '-NonInteractive', '-File', $cmd, '-Approver', "Concurrent $i", '-Decision', 'approved', '-Target', 'gate:m6-start', '-Rationale', "Run $i.", '-Actor', 'human', '-StorePath', $store)) { $psi.ArgumentList.Add($a) }
            $psi.RedirectStandardOutput = $true; $psi.RedirectStandardError = $true; $psi.UseShellExecute = $false
            $p = [System.Diagnostics.Process]::Start($psi); $p.WaitForExit(); $p.ExitCode
        } -ArgumentList $addCommand, $store, $i
    }
    $codes = @($jobs | Wait-Job | Receive-Job); $jobs | Remove-Job
    $seqs = @(Get-LineTexts $store | ForEach-Object { (ConvertFrom-JsonStrict -Text $_)['seq'] })
    Test-Case 'concurrency: six concurrent invocations give six records with seq 1 to 6 and a chain that verifies' ((@($codes | Where-Object { $_ -ne 0 }).Count -eq 0) -and (($seqs -join ',') -eq '1,2,3,4,5,6') -and (Test-ApprovalStore -StorePath $store).Ok) "codes=$($codes -join ',') seqs=$($seqs -join ',')"

    # ---- a failed write is not reported as stored, and leaves no temp file
    $dir = New-TempDir
    $store = New-Store $dir ''
    [void](Invoke-Req $store ([ordered]@{ operation = 'append'; candidate = (New-Candidate) }))
    $before = Get-FileBytesOrEmpty $store
    [void][IO.Directory]::CreateDirectory($store + '.tmp')   # the temporary file cannot be created
    $wf = Invoke-Req $store ([ordered]@{ operation = 'append'; candidate = (New-Candidate -Over @{ decision = 'rejected' }) })
    Test-Case 'a failed write gives write_failed, exit non-zero, and the store is byte-identical' ($wf.Outcome -eq 'write_failed' -and $wf.ExitCode -ne 0 -and (Test-BytesEqual $before (Get-FileBytesOrEmpty $store)))
    [IO.Directory]::Delete($store + '.tmp')
    $lock = [IO.File]::Open($store, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::Read)
    try { $wf2 = Invoke-Req $store ([ordered]@{ operation = 'append'; candidate = (New-Candidate -Over @{ decision = 'rejected' }) }) } finally { $lock.Dispose() }
    Test-Case 'a replace that fails is not reported as stored and removes its temporary file' ($wf2.Outcome -eq 'write_failed' -and (Test-BytesEqual $before (Get-FileBytesOrEmpty $store)) -and -not (Test-Path -LiteralPath ($store + '.tmp')))

    # ---- static checks
    $toolFiles = Get-ChildItem -LiteralPath $script:ToolsDir -File -Include *.ps1, *.psm1 -Recurse
    $writers = @($toolFiles | Where-Object { (Get-Content -Raw -LiteralPath $_.FullName) -match 'Write-StoreAtomically' } | ForEach-Object { $_.Name })
    Test-Case 'static: only ApprovalStore.psm1 contains the atomic store write' (($writers -join ',') -ceq 'ApprovalStore.psm1') ($writers -join ',')
    $writeApi = '\[(System\.)?IO\.File\]::(Write|Append|Replace|Move|Copy|Delete|Create|Open)|FileStream|Set-Content|Add-Content|Out-File|New-Item|Remove-Item|Move-Item|Copy-Item'
    foreach ($thin in @($addCommand, $harness)) {
        Test-Case "static: $(Split-Path -Leaf $thin) contains no file-write operation (it only builds a request)" (-not ((Get-Content -Raw -LiteralPath $thin) -match $writeApi))
    }
    $addText = Get-Content -Raw -LiteralPath $addCommand
    $tokens = $null; $errors = $null
    $ast = [System.Management.Automation.Language.Parser]::ParseFile($addCommand, [ref]$tokens, [ref]$errors)
    $params = @($ast.ParamBlock.Parameters | ForEach-Object { $_.Name.VariablePath.UserPath })
    Test-Case 'static: Add-ApprovalRecord.ps1 declares no modify, delete, timestamp, or request-file parameter' ((@($params | Where-Object { $_ -match 'modify|delete|timestamp|request|operation' }).Count -eq 0) -and $errors.Count -eq 0) ($params -join ',')
    Test-Case 'static: Add-ApprovalRecord.ps1 sends only append requests' (($addText -match "operation = 'append'") -and -not ($addText -match "operation = '(modify|delete)'"))
    Test-Case 'static: no tool reads environment variables for approval values' (-not ($addText -match '\$env:'))
}