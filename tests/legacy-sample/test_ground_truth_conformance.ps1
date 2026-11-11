#Requires -Version 7.0
# Runs the Ground Truth evaluation runner against the live legacy app and checks the result.
# After the project owner's approval, the six invalid-quantity units are approved divergences:
# the mismatch must still be detected, and each must be covered by a decided migration decision.
# Negative controls feed deliberately wrong copies of the Ground Truth or the decision registry
# (temporary files only) and confirm that the gate fails. The real files are never modified.
. (Join-Path $PSScriptRoot 'lib/common.ps1')

$script:Runner = Join-Path $script:RepoRoot 'evaluation/runner/Invoke-GroundTruthEvaluation.ps1'
$script:GtPath = Join-Path $script:RepoRoot 'evaluation/ground-truth/ground-truth.json'
$script:DecPath = Join-Path $script:RepoRoot 'evaluation/migration-decisions.json'
$script:Work = Join-Path ([IO.Path]::GetTempPath()) ('phoenix-gtc-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $script:Work | Out-Null
$script:Divergent = @('SCN-015', 'SCN-016', 'SCN-017-a', 'SCN-017-b', 'SCN-017-c', 'SCN-017-d')

function Invoke-Runner {
    param([string]$Name, [string]$GroundTruth = $script:GtPath, [string]$Decisions = $script:DecPath)
    $out = Join-Path $script:Work "$Name.json"
    & pwsh -NoProfile -NonInteractive -File $script:Runner -BaseUrl $script:BaseUrl -GroundTruthPath $GroundTruth -DecisionsPath $Decisions -OutputPath $out *> (Join-Path $script:Work "$Name.log")
    $code = $LASTEXITCODE
    $json = if (Test-Path $out) { Get-Content -Raw $out | ConvertFrom-Json -Depth 40 } else { $null }
    [pscustomobject]@{ Code = $code; Json = $json }
}

function Save-Copy {
    param($Object, [string]$Name)
    $p = Join-Path $script:Work $Name
    [IO.File]::WriteAllText($p, (ConvertTo-Json -InputObject $Object -Depth 40), (New-Object Text.UTF8Encoding($false)))
    $p
}

function Get-Unit { param($Gt, [string]$Id)
    foreach ($s in $Gt.scenarios) {
        if ($s.id -eq $Id) { return $s }
        if ($s.PSObject.Properties['variants']) { foreach ($v in $s.variants) { if ($v.id -eq $Id) { return $v } } }
    }
}

function Get-Classes { param($Json) $h = [ordered]@{}; foreach ($s in $Json.scenarios) { $h[$s.id] = $s.classification }; $h }
function Read-Decisions { $script:DecText | ConvertFrom-Json -Depth 40 -DateKind String }

Invoke-TestMain {
    try {
        $gtText = Get-Content -Raw $script:GtPath
        $script:DecText = Get-Content -Raw $script:DecPath

        # --- actual run ---
        $r = Invoke-Runner 'actual'
        $j = $r.Json
        Test-Case 'GC1 runner exits 0 and the gate passes' ($r.Code -eq 0 -and $j.summary.gate -eq 'pass') "exit=$($r.Code)"
        $cls = Get-Classes $j
        $matchIds = @($cls.Keys | Where-Object { $cls[$_] -eq 'match' })
        Test-Case 'GC2 SCN-001..SCN-014 match the expected specification' (($matchIds -join ',') -eq ((1..14 | ForEach-Object { 'SCN-{0:D3}' -f $_ }) -join ',')) ($matchIds -join ',')
        $div = @($cls.Keys | Where-Object { $cls[$_] -eq 'approved_divergence' })
        Test-Case 'GC3 SCN-015, 016, 017-a/b/c/d are approved divergences' (($div -join ',') -eq ($script:Divergent -join ',')) ($div -join ',')
        $notDetected = @($j.scenarios | Where-Object { $_.id -in $script:Divergent -and ($_.comparison.result -ne 'mismatch' -or @($_.comparison.differences).Count -eq 0) } | ForEach-Object { $_.id })
        Test-Case 'GC4 each approved divergence is a detected mismatch with recorded differences (not ignored)' ($notDetected.Count -eq 0) ($notDetected -join ',')
        $d = $j.scenarios | Where-Object id -eq 'SCN-017-d'
        $dDiff = @($d.comparison.differences) -join ' | '
        Test-Case 'GC5 SCN-017-d is compared: expected 400, legacy 201 with an order and stock 495' ($d.comparison.result -eq 'mismatch' -and $dDiff -match 'expected 400, observed 201' -and $dDiff -match 'expected 500, observed 495' -and $d.migration_decision.decision_id -eq 'MD-006') $dDiff
        $c = $j.summary.scenario_counts
        Test-Case 'GC6 summary counts: 20 units, 14 match, 6 approved divergences, nothing pending or failing' ($j.summary.scenario_units -eq 20 -and $c.match -eq 14 -and $c.approved_divergence -eq 6 -and ($c.mismatch_replicate_legacy + $c.mismatch_decision_pending + $c.specification_decision_pending + $c.unexpected_mismatch + $c.stale_registry_entry + $c.error) -eq 0 -and @($j.summary.registry_validation.errors).Count -eq 0) ($c | ConvertTo-Json -Compress)

        $obs = [ordered]@{}
        foreach ($id in $script:Divergent) { $obs[$id] = ($j.scenarios | Where-Object id -eq $id).observed_legacy_behavior.steps[-1].response.status }
        $obsText = ($obs.Keys | ForEach-Object { "$_=$($obs[$_])" }) -join ','
        Test-Case 'GC7 observed legacy statuses of the divergent units are recorded (409, 500, 201, 409, 409, 201)' ($obsText -eq 'SCN-015=409,SCN-016=500,SCN-017-a=201,SCN-017-b=409,SCN-017-c=409,SCN-017-d=201') $obsText

        $gtNow = $gtText | ConvertFrom-Json -Depth 40
        $sepBad = New-Object System.Collections.Generic.List[string]
        foreach ($s in $j.scenarios) {
            $u = Get-Unit $gtNow $s.id
            $same = (ConvertTo-Json $s.expected_specification -Depth 30 -Compress) -eq (ConvertTo-Json $u.expected_specification -Depth 30 -Compress)
            if (-not $same -or $null -eq $s.observed_legacy_behavior -or $null -eq $s.migration_decision) { $sepBad.Add($s.id) }
        }
        Test-Case 'GC8 each unit keeps expected specification (unchanged from GT), observed behavior and migration decision separately' ($sepBad.Count -eq 0) ($sepBad -join ',')
        $noDecision = @($j.scenarios | Where-Object { $_.classification -eq 'match' -and $_.migration_decision.status -ne 'not_applicable' } | ForEach-Object { $_.id })
        Test-Case 'GC9 matching units carry no migration decision' ($noDecision.Count -eq 0) ($noDecision -join ',')

        $bc = $j.summary.boundary_cases
        Test-Case 'GC10 boundary cases: 10 executed and matching, BC-001 not executed and not counted as a pass' ($bc.total -eq 11 -and $bc.executed -eq 10 -and $bc.counts.match -eq 10 -and $bc.counts.mismatch -eq 0 -and $bc.counts.not_executed -eq 1) ($bc | ConvertTo-Json -Compress)
        $b1 = $j.boundary_cases | Where-Object id -eq 'BC-001'
        Test-Case 'GC11 BC-001 has no observed response and records the reason it was not executed' ($b1.comparison.result -eq 'not_executed' -and $null -eq $b1.observed -and [string]$b1.comparison.not_executed_reason -match 'not enforce') ($b1.comparison | ConvertTo-Json -Compress)
        $b10 = $j.boundary_cases | Where-Object id -eq 'BC-010'; $b11 = $j.boundary_cases | Where-Object id -eq 'BC-011'
        Test-Case 'GC12 BC-010 (5299: fee 500, total 5499) and BC-011 (5300: fee 0, total 5000) match on the live app' ($b10.comparison.result -eq 'match' -and $b10.observed.body.data.shipping_fee -eq 500 -and $b10.observed.body.data.total -eq 5499 -and $b11.comparison.result -eq 'match' -and $b11.observed.body.data.shipping_fee -eq 0 -and $b11.observed.body.data.total -eq 5000)
        $s6 = $j.scenarios | Where-Object id -eq 'SCN-006'
        Test-Case 'GC13 SCN-006 compares available and requested (match on 50 / 51)' ($s6.classification -eq 'match' -and $s6.expected_specification.step_expectations.s1.fields.PSObject.Properties['details.products[*].available'] -and $s6.observed_legacy_behavior.steps[0].response.body.details.products[0].available -eq 50)

        $ad = $j.approved_divergences
        $adIds = @($ad.items | ForEach-Object { "$($_.scenario)=$($_.decision_id)" }) -join ','
        Test-Case 'GC14 approved divergence list for the Compatibility_Evaluation names all six with their decisions and targets' ($ad.count -eq 6 -and $adIds -eq 'SCN-015=MD-001,SCN-016=MD-002,SCN-017-a=MD-003,SCN-017-b=MD-004,SCN-017-c=MD-005,SCN-017-d=MD-006' -and @($ad.items | Where-Object { $_.approved_target.status -ne 400 -or $_.decided_by -ne 'Masato Nagata (project owner)' }).Count -eq 0) $adIds
        Test-Case 'GC15 Ground Truth and registry files were not modified by the run' ((Get-Content -Raw $script:GtPath) -eq $gtText -and (Get-Content -Raw $script:DecPath) -eq $script:DecText)

        # --- negative controls (temporary copies only) ---
        $g = $gtText | ConvertFrom-Json -Depth 40
        (Get-Unit $g 'SCN-001').expected_specification.step_expectations.s1.fields.'data.total' = 1541
        $n1 = Invoke-Runner 'neg-wrong-total' -GroundTruth (Save-Copy $g 'gt-wrong-total.json')
        $c1 = Get-Classes $n1.Json
        Test-Case 'GN1 a wrong expected total (SCN-001 1541) fails the gate as an unexpected mismatch' ($n1.Code -eq 1 -and $c1['SCN-001'] -eq 'unexpected_mismatch' -and $n1.Json.summary.scenario_counts.unexpected_mismatch -eq 1) "exit=$($n1.Code) SCN-001=$($c1['SCN-001'])"
        Test-Case 'GN2 the approved divergences keep their classification in that failing run' ($n1.Json.summary.scenario_counts.approved_divergence -eq 6)

        $g = $gtText | ConvertFrom-Json -Depth 40
        $e = (Get-Unit $g 'SCN-015').expected_specification
        $e.step_expectations.s1.status = 409
        $e.step_expectations.s1.fields.error = 'Insufficient stock'
        $n2 = Invoke-Runner 'neg-stale' -GroundTruth (Save-Copy $g 'gt-stale.json')
        $c2 = Get-Classes $n2.Json
        Test-Case 'GN3 an expectation edited to match legacy behavior leaves a stale decision record and fails the gate' ($n2.Code -eq 1 -and $c2['SCN-015'] -eq 'stale_registry_entry') "exit=$($n2.Code) SCN-015=$($c2['SCN-015'])"

        $dd = Read-Decisions
        $dd.decisions = @($dd.decisions | Where-Object { $_.id -ne 'MD-001' })
        $n3 = Invoke-Runner 'neg-no-md001' -Decisions (Save-Copy $dd 'dec-no-md001.json')
        $c3 = Get-Classes $n3.Json
        Test-Case 'GN4 a mismatch without a decision record (MD-001 removed) fails the gate' ($n3.Code -eq 1 -and $c3['SCN-015'] -eq 'unexpected_mismatch') "exit=$($n3.Code) SCN-015=$($c3['SCN-015'])"

        $dd = Read-Decisions
        $m = $dd.decisions | Where-Object id -eq 'MD-006'
        $m.decision = 'pending'; $m.decided_by = $null; $m.decided_at = $null
        $n4 = Invoke-Runner 'neg-pending' -Decisions (Save-Copy $dd 'dec-pending.json')
        $c4 = Get-Classes $n4.Json
        Test-Case 'GN5 an unapproved (pending) mismatch fails the gate' ($n4.Code -eq 1 -and $c4['SCN-017-d'] -eq 'mismatch_decision_pending') "exit=$($n4.Code) SCN-017-d=$($c4['SCN-017-d'])"

        $g = $gtText | ConvertFrom-Json -Depth 40
        $b = $g.boundary_cases | Where-Object id -eq 'BC-010'
        $b.expected_total = 5799
        $n5 = Invoke-Runner 'neg-boundary' -GroundTruth (Save-Copy $g 'gt-boundary.json')
        $b5 = $n5.Json.boundary_cases | Where-Object id -eq 'BC-010'
        Test-Case 'GN6 a wrong boundary total (BC-010 5799) fails the gate' ($n5.Code -eq 1 -and $b5.comparison.result -eq 'mismatch' -and $n5.Json.summary.boundary_cases.counts.mismatch -eq 1) "exit=$($n5.Code)"

        $dd = Read-Decisions
        $m = $dd.decisions | Where-Object id -eq 'MD-002'
        $m.decided_by = $null
        $n6 = Invoke-Runner 'neg-no-approver' -Decisions (Save-Copy $dd 'dec-no-approver.json')
        Test-Case 'GN7 a decided record without decided_by is a registry error and fails the gate' ($n6.Code -eq 1 -and (@($n6.Json.summary.registry_validation.errors) -join ';') -match 'MD-002: decided_by is missing') (@($n6.Json.summary.registry_validation.errors) -join ';')

        $dd = Read-Decisions
        ($dd.decisions | Where-Object id -eq 'MD-006').defect_candidates = @('DC-006')
        $n7 = Invoke-Runner 'neg-dc' -Decisions (Save-Copy $dd 'dec-dc.json')
        Test-Case 'GN8 a record whose defect candidates differ from the Ground Truth is a registry error and fails the gate' ($n7.Code -eq 1 -and (@($n7.Json.summary.registry_validation.errors) -join ';') -match 'MD-006: defect candidates differ') (@($n7.Json.summary.registry_validation.errors) -join ';')

        $g = $gtText | ConvertFrom-Json -Depth 40
        ((Get-Unit $g 'SCN-006').expected_specification.step_expectations.s1.fields).'details.products[*].available' = @(49)
        $n8 = Invoke-Runner 'neg-available' -GroundTruth (Save-Copy $g 'gt-available.json')
        $c8 = Get-Classes $n8.Json
        Test-Case 'GN9 a wrong available value in SCN-006 is detected (the field is compared)' ($n8.Code -eq 1 -and $c8['SCN-006'] -eq 'unexpected_mismatch') "exit=$($n8.Code) SCN-006=$($c8['SCN-006'])"

        $dd = Read-Decisions
        ($dd.decisions | Where-Object id -eq 'MD-001').decision = 'replicate_legacy_behavior'
        $n9 = Invoke-Runner 'pos-replicate' -Decisions (Save-Copy $dd 'dec-replicate.json')
        $c9 = Get-Classes $n9.Json
        Test-Case 'GN10 a replicate_legacy_behavior decision is reported separately and is not an approved divergence' ($n9.Code -eq 0 -and $c9['SCN-015'] -eq 'mismatch_replicate_legacy' -and $n9.Json.approved_divergences.count -eq 5) "exit=$($n9.Code) SCN-015=$($c9['SCN-015'])"

        Test-Case 'GN11 the real Ground Truth and registry are unchanged after the negative controls' ((Get-Content -Raw $script:GtPath) -eq $gtText -and (Get-Content -Raw $script:DecPath) -eq $script:DecText)
    } finally {
        Remove-Item -LiteralPath $script:Work -Recurse -Force -ErrorAction SilentlyContinue
    }
}