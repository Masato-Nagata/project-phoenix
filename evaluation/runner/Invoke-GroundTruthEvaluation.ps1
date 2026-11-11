#Requires -Version 7.0
<#
Runs the Ground Truth scenarios against the live legacy app and records, for each scenario,
the expected specification, the observed legacy behavior, the comparison, and the migration decision.

This is a conformance run of the legacy app against the expected specification. It is neither the
Spec_Restoration_Evaluation (AI-restored spec vs Ground Truth) nor the Compatibility_Evaluation
(legacy vs modern app). It never edits an expected value.
#>
param(
    [string]$BaseUrl = 'http://127.0.0.1:8056',
    [string]$GroundTruthPath = '',
    [string]$DecisionsPath = '',
    [string]$AllowlistPath = '',
    [string]$OutputPath = '',
    [string]$RawOutputPath = ''
)
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'EvalCommon.ps1')

# Scenarios reset and mutate the shared legacy DB, so concurrent runs corrupt each other's results.
# The mutex is released automatically when this process exits.
$runLock = New-Object System.Threading.Mutex($false, 'Local\ProjectPhoenixGroundTruthEvaluation')
if (-not $runLock.WaitOne(0)) { Write-Host 'another Ground Truth evaluation run is in progress; refusing to run concurrently'; exit 2 }

$repoRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../..'))
if (-not $GroundTruthPath) { $GroundTruthPath = Join-Path $repoRoot 'evaluation/ground-truth/ground-truth.json' }
if (-not $DecisionsPath)   { $DecisionsPath   = Join-Path $repoRoot 'evaluation/migration-decisions.json' }
if (-not $AllowlistPath)   { $AllowlistPath   = Join-Path $repoRoot 'docs/ai-input-allowlist.json' }
if (-not $OutputPath)      { $OutputPath      = Join-Path $repoRoot 'evaluation/results/ground-truth-conformance.json' }

$gt = Get-Content -Raw $GroundTruthPath | ConvertFrom-Json -Depth 30
$decisions = Get-Content -Raw $DecisionsPath | ConvertFrom-Json -Depth 30 -DateKind String
$allowlist = Get-Content -Raw $AllowlistPath | ConvertFrom-Json -Depth 30
$nonDet = @($gt.meta.non_deterministic_fields)
$canary = [string]$gt.meta.canary
$rawEvidence = New-Object System.Collections.Generic.List[object]

$health = Invoke-EvalHttp -BaseUrl $BaseUrl -Method GET -Path '/health'
if ($health.Status -ne 200) { Write-Host "legacy app is not healthy at $BaseUrl (HTTP $($health.Status))"; exit 2 }

function Invoke-EvalReset {
    $r = Invoke-EvalHttp -BaseUrl $BaseUrl -Method POST -Path '/reset'
    if ($r.Status -ne 200 -or -not $r.Body.success) { throw "reset failed before a scenario: HTTP $($r.Status) $($r.Raw)" }
}

function Invoke-Request {
    param($Request, [hashtable]$Vars, [string]$Label)
    $path = Resolve-TemplateString ([string]$Request.path) $Vars
    $body = $null
    if ($Request.PSObject.Properties['body']) { $body = $Request.body }
    $resp = Invoke-EvalHttp -BaseUrl $BaseUrl -Method ([string]$Request.method) -Path $path -Body $body
    $rawEvidence.Add([ordered]@{ label = $Label; method = [string]$Request.method; path = $path; status = $resp.Status; raw_body = $resp.Raw })
    $resp
}

function New-ObservedRecord {
    param($Request, $Resolved, $Resp)
    [ordered]@{
        request = [ordered]@{
            method = [string]$Request.method
            path   = $Resolved
            body   = $(if ($Request.PSObject.Properties['body']) { $Request.body } else { $null })
        }
        response = [ordered]@{
            status = $Resp.Status
            body   = (Get-MaskedBody -Raw $Resp.Raw -NonDeterministicPaths $nonDet)
        }
    }
}

function Invoke-Unit {
    param($Unit)
    Invoke-EvalReset
    $vars = @{ canary = $canary }
    $stepRecords = New-Object System.Collections.Generic.List[object]
    $checkRecords = New-Object System.Collections.Generic.List[object]
    $diffs = New-Object System.Collections.Generic.List[string]
    $comparable = $true
    $ncReasons = New-Object System.Collections.Generic.List[string]
    $errored = $false
    $spec = $Unit.expected_specification

    foreach ($step in $Unit.steps) {
        $resolvedPath = Resolve-TemplateString ([string]$step.request.path) $vars
        $resp = Invoke-Request $step.request $vars "$($Unit.id)/$($step.id)"
        $rec = New-ObservedRecord $step.request $resolvedPath $resp
        $rec['step'] = [string]$step.id
        $rec['role'] = [string]$step.role
        $stepRecords.Add([pscustomobject]$rec)
        if ($step.PSObject.Properties['capture']) {
            foreach ($c in $step.capture.PSObject.Properties) {
                $v = Get-PathValue $resp.Body ([string]$c.Value)
                if (-not $v.Exists) { $errored = $true; $diffs.Add("capture '$($c.Name)' not found at $($c.Value)") } else { $vars[$c.Name] = $v.Value }
            }
        }
        if ([string]$step.role -eq 'setup' -and ($resp.Status -lt 200 -or $resp.Status -ge 300)) {
            $errored = $true
            $diffs.Add("setup step $($step.id) failed with HTTP $($resp.Status)")
        }
        $exp = $spec.step_expectations.PSObject.Properties[[string]$step.id]
        if ($exp) {
            $t = Test-ResponseExpectation $resp $exp.Value $vars
            if (-not $t.Comparable) { $comparable = $false; $ncReasons.Add("step $($step.id): expected specification is undetermined: $([string]$exp.Value.reason)") }
            foreach ($d in $t.Differences) { $diffs.Add((Get-MaskedText "step $($step.id): $d")) }
        }
    }

    foreach ($chk in $spec.state_checks) {
        $resolvedPath = Resolve-TemplateString ([string]$chk.request.path) $vars
        $resp = Invoke-Request $chk.request $vars "$($Unit.id)/$($chk.id)"
        $rec = New-ObservedRecord $chk.request $resolvedPath $resp
        $rec['check'] = [string]$chk.id
        $checkRecords.Add([pscustomobject]$rec)
        $expect = [pscustomobject]@{ status = $chk.status; fields = $chk.fields }
        $t = Test-ResponseExpectation $resp $expect $vars
        foreach ($d in $t.Differences) { $diffs.Add((Get-MaskedText "state check $($chk.id): $d")) }
    }

    $result = if ($errored) { 'error' } elseif (-not $comparable) { 'not_comparable' } elseif ($diffs.Count -eq 0) { 'match' } else { 'mismatch' }
    [pscustomobject]@{ Result = $result; NotComparableReason = $(if ($ncReasons.Count) { $ncReasons -join '; ' } else { $null }); Differences = $diffs.ToArray(); Steps = $stepRecords.ToArray(); Checks = $checkRecords.ToArray() }
}

# Flatten scenarios (SCN-017 has variants)
$units = New-Object System.Collections.Generic.List[object]
foreach ($s in $gt.scenarios) {
    if ($s.PSObject.Properties['variants']) {
        foreach ($v in $s.variants) {
            $units.Add([pscustomobject]@{
                id = $v.id; title = $v.title; category = $s.category; requirements = $s.requirements
                steps = $v.steps; expected_specification = $v.expected_specification; defect_candidates = $v.defect_candidates
            })
        }
    } else {
        $units.Add($s)
    }
}

# --- decision registry validation (a registry with contradictions or gaps fails the gate) ---
$registryErrors = New-Object System.Collections.Generic.List[string]
$unitById = @{}
foreach ($x in $units) { $unitById[[string]$x.id] = $x }
$allowedDecisions = @($decisions.allowed_decisions)
$allowedKinds = @($decisions.kinds.PSObject.Properties.Name)
$isoOffset = '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?([+-]\d{2}:\d{2}|Z)$'
$seenIds = @{}
$decisionById = @{}
foreach ($d in $decisions.decisions) {
    $id = [string]$d.id
    if ($seenIds.ContainsKey($id)) { $registryErrors.Add("$($id): duplicate decision id") }
    $seenIds[$id] = $true
    $scn = [string]$d.scenario
    if ($decisionById.ContainsKey($scn)) { $registryErrors.Add("$($id): scenario $scn already has a decision record") }
    $decisionById[$scn] = $d
    $unit = $unitById[$scn]
    if (-not $unit) { $registryErrors.Add("$($id): scenario $scn does not exist in the Ground Truth"); continue }
    if ((@($d.defect_candidates) -join ',') -ne (@($unit.defect_candidates) -join ',')) { $registryErrors.Add("$($id): defect candidates differ from $scn") }
    $dec = [string]$d.decision
    if ($dec -notin $allowedDecisions) { $registryErrors.Add("$($id): decision '$dec' is not allowed") }
    if ([string]$d.kind -notin $allowedKinds) { $registryErrors.Add("$($id): kind '$($d.kind)' is not allowed") }
    if ($dec -eq 'pending') {
        if ($d.decided_by -or $d.decided_at) { $registryErrors.Add("$($id): pending decision has decided_by or decided_at") }
    } else {
        if (-not [string]$d.decided_by) { $registryErrors.Add("$($id): decided_by is missing") }
        if ([string]$d.decided_at -notmatch $isoOffset) { $registryErrors.Add("$($id): decided_at is missing or not ISO 8601 with offset") }
        if (-not [string]$d.rationale) { $registryErrors.Add("$($id): rationale is missing") }
        if ([string]$d.kind -eq 'specification_decision') { $registryErrors.Add("$($id): a specification decision cannot carry a migration decision; decide the specification in the Ground Truth first") }
    }
    $undet = @($unit.expected_specification.step_expectations.PSObject.Properties | Where-Object { $_.Value.PSObject.Properties['undetermined'] }).Count -gt 0
    if ($undet -and [string]$d.kind -ne 'specification_decision') { $registryErrors.Add("$($id): $scn has an undetermined expectation but the record is not a specification decision") }
}

$scenarioResults = New-Object System.Collections.Generic.List[object]
$approvedDivergences = New-Object System.Collections.Generic.List[object]
$counts = [ordered]@{ match = 0; approved_divergence = 0; mismatch_replicate_legacy = 0; mismatch_decision_pending = 0; specification_decision_pending = 0; unexpected_mismatch = 0; stale_registry_entry = 0; error = 0 }

foreach ($u in $units) {
    $r = Invoke-Unit $u
    $reg = $decisionById[[string]$u.id]
    $md = [ordered]@{ status = 'not_applicable'; decision_id = $null; decision = $null }
    if ($reg) { $md = [ordered]@{ status = $(if ([string]$reg.decision -eq 'pending') { 'pending' } else { 'decided' }); decision_id = [string]$reg.id; decision = [string]$reg.decision; kind = [string]$reg.kind; decided_by = $(if ($reg.decided_by) { [string]$reg.decided_by } else { $null }) } }
    $classification = ''
    if ($r.Result -eq 'error') {
        $classification = 'error'
    } elseif ($r.Result -eq 'match') {
        if ($reg) { $classification = 'stale_registry_entry'; $md.status = 'registry_entry_without_mismatch' } else { $classification = 'match' }
    } elseif (-not $reg) {
        $classification = 'unexpected_mismatch'
        $md = [ordered]@{ status = 'missing_decision_record'; decision_id = $null; decision = $null }
    } elseif ($r.Result -eq 'not_comparable') {
        $classification = 'specification_decision_pending'
    } else {
        switch ([string]$reg.decision) {
            'follow_expected_specification' { $classification = 'approved_divergence' }
            'replicate_legacy_behavior'     { $classification = 'mismatch_replicate_legacy' }
            default                         { $classification = 'mismatch_decision_pending' }
        }
    }
    $counts[$classification]++
    if ($classification -eq 'approved_divergence') {
        $lastAction = @($r.Steps | Where-Object { $_.role -eq 'action' })[-1]
        $target = $u.expected_specification.step_expectations.PSObject.Properties[[string]$lastAction.step].Value
        $legacyError = $null
        if ($lastAction.response.body -and $lastAction.response.body.PSObject.Properties['error']) { $legacyError = [string]$lastAction.response.body.error }
        $targetError = $null
        if ($target.fields -and $target.fields.PSObject.Properties['error']) { $targetError = [string]$target.fields.error }
        $approvedDivergences.Add([ordered]@{
            scenario          = [string]$u.id
            decision_id       = [string]$reg.id
            defect_candidates = @($u.defect_candidates)
            decision          = [string]$reg.decision
            decided_by        = [string]$reg.decided_by
            legacy_response   = [ordered]@{ status = $lastAction.response.status; error = $legacyError }
            approved_target   = [ordered]@{ status = $target.status; error = $targetError }
            differences       = $r.Differences
        })
    }
    $scenarioResults.Add([ordered]@{
        id                       = [string]$u.id
        title                    = [string]$u.title
        category                 = [string]$u.category
        requirements             = @($u.requirements)
        defect_candidates        = @($u.defect_candidates)
        expected_specification   = $u.expected_specification
        observed_legacy_behavior = [ordered]@{ steps = $r.Steps; state_checks = $r.Checks }
        comparison               = [ordered]@{ result = $r.Result; differences = $r.Differences; not_comparable_reason = $r.NotComparableReason }
        migration_decision       = $md
        classification           = $classification
    })
    Write-Host ("{0,-10} {1,-18} {2}" -f $u.id, $r.Result, $classification)
}
foreach ($e in $registryErrors) { Write-Host "registry error: $e" }
# Boundary cases through a temporary 1-yen fixture product
$bcResults = New-Object System.Collections.Generic.List[object]
$bcCounts = [ordered]@{ match = 0; mismatch = 0; not_executed = 0 }
Invoke-EvalReset
Invoke-EvalSql -RepoRoot $repoRoot -Sql "INSERT INTO products (id, name, unit_price, stock_quantity) VALUES (101, 'GT Boundary Fixture 1 yen', 1, 999999)"
foreach ($bc in $gt.boundary_cases) {
    if ($bc.PSObject.Properties['execution'] -and [string]$bc.execution -eq 'not_executed') {
        $bcCounts.not_executed++
        $bcResults.Add([ordered]@{ id = [string]$bc.id; subtotal = [int]$bc.subtotal; expected = $bc; observed = $null; comparison = [ordered]@{ result = 'not_executed'; differences = @(); not_executed_reason = [string]$bc.reason } })
        Write-Host ("{0,-10} {1}" -f $bc.id, 'not_executed')
        continue
    }
    $body = [pscustomobject]@{ customer_id = 1; lines = @([pscustomobject]@{ product_id = 101; quantity = [int]$bc.subtotal }) }
    $reqObj = [pscustomobject]@{ method = 'POST'; path = '/orders'; body = $body }
    $resp = Invoke-Request $reqObj @{} "$($bc.id)"
    $diffs = New-Object System.Collections.Generic.List[string]
    if ($bc.order_accepted) {
        if ($resp.Status -ne 201) { $diffs.Add("status: expected 201, observed $($resp.Status)") }
        foreach ($pair in @(@('data.subtotal', [int]$bc.subtotal), @('data.discount', [int]$bc.expected_discount), @('data.shipping_fee', [int]$bc.expected_shipping_fee), @('data.total', [int]$bc.expected_total))) {
            $m = Test-FieldExpectation $resp.Body $pair[0] $pair[1]
            if ($m) { $diffs.Add((Get-MaskedText $m)) }
        }
    } else {
        if ($resp.Status -ne [int]$bc.expected_rejection.status) { $diffs.Add("status: expected $($bc.expected_rejection.status), observed $($resp.Status)") }
        $m = Test-FieldExpectation $resp.Body 'error' ([string]$bc.expected_rejection.error)
        if ($m) { $diffs.Add((Get-MaskedText $m)) }
    }
    $res = $(if ($diffs.Count -eq 0) { 'match' } else { 'mismatch' })
    $bcCounts[$res]++
    $bcResults.Add([ordered]@{
        id = [string]$bc.id; subtotal = [int]$bc.subtotal; expected = $bc
        observed = [ordered]@{ status = $resp.Status; body = (Get-MaskedBody -Raw $resp.Raw -NonDeterministicPaths $nonDet) }
        comparison = [ordered]@{ result = $res; differences = $diffs.ToArray() }
    })
    Write-Host ("{0,-10} {1}" -f $bc.id, $res)
}
Invoke-EvalReset

$legacySources = @()
foreach ($f in $allowlist.files) {
    $legacySources += [ordered]@{ path = [string]$f; sha256_lf = (Get-Sha256Lf (Join-Path $repoRoot ([string]$f))) }
}

$gateFail = ($counts.unexpected_mismatch + $counts.stale_registry_entry + $counts.error + $counts.mismatch_decision_pending + $counts.specification_decision_pending + $registryErrors.Count + $bcCounts.mismatch) -gt 0
$result = [ordered]@{
    schema_version = 1
    kind           = 'ground_truth_conformance_of_legacy_app'
    notes          = @(
        'Conformance run of the legacy app against the expected specification in the Ground Truth.',
        'It is not the Spec_Restoration_Evaluation (AI-restored spec vs Ground Truth) and not the Compatibility_Evaluation (legacy vs modern app).',
        'Expected specification and observed legacy behavior are recorded separately. Expected values are never changed to match observed behavior.',
        'Non-deterministic fields are masked as <non-deterministic>. No wall-clock values are stored, so repeated runs produce identical files.',
        'approved_divergence: the legacy behavior differs from the expected specification and a recorded human decision says the modern app follows the expected specification.',
        'mismatch_decision_pending and specification_decision_pending: a difference, or an undetermined expectation, without an approved decision. Both fail the gate.'
    )
    inputs         = [ordered]@{
        ground_truth        = [ordered]@{ file = 'evaluation/ground-truth/ground-truth.json'; sha256_lf = (Get-Sha256Lf $GroundTruthPath); authoring_status = [string]$gt.meta.authoring.status }
        migration_decisions = [ordered]@{ file = 'evaluation/migration-decisions.json'; sha256_lf = (Get-Sha256Lf $DecisionsPath) }
        legacy_sources      = $legacySources
        non_deterministic_fields = $nonDet
    }
    gate_rule      = 'Pass only when every scenario unit is a match without a decision record, or a mismatch covered by a decided migration decision (approved_divergence for follow_expected_specification, mismatch_replicate_legacy for replicate_legacy_behavior); the decision registry has no errors (unknown or duplicate entries, defect candidates that differ from the Ground Truth, decided entries without decided_by, decided_at or rationale, decisions on undetermined expectations); and every executed boundary case matches. A mismatch without a record, a pending decision, an undetermined expectation, a record whose unit now matches, and any execution error fail the gate. Boundary cases that were not executed are reported as not_executed and are not counted as passes.'
    summary        = [ordered]@{
        scenario_units = $units.Count
        scenario_counts = $counts
        boundary_cases = [ordered]@{ total = $gt.boundary_cases.Count; executed = ($bcCounts.match + $bcCounts.mismatch); counts = $bcCounts; note = 'Cases that were not executed are not counted as passes.' }
        registry_validation = [ordered]@{ errors = $registryErrors.ToArray() }
        gate = $(if ($gateFail) { 'fail' } else { 'pass' })
    }
    approved_divergences = [ordered]@{
        note  = 'Intentional incompatibilities approved by a recorded migration decision (follow_expected_specification). The Compatibility_Evaluation must report these scenarios as approved divergences: the modern app is expected to differ from the legacy response and to return the approved target. For every other scenario the legacy response stays the reference (R13.3).'
        count = $approvedDivergences.Count
        items = $approvedDivergences
    }
    scenarios      = $scenarioResults
    boundary_cases = $bcResults
}
Write-StableJson -Path $OutputPath -Object $result
if ($RawOutputPath) { Write-StableJson -Path $RawOutputPath -Object ([ordered]@{ note = 'Unmasked responses for diagnostics only. Not deterministic.'; responses = $rawEvidence }) }

Write-Host ''
Write-Host ("units={0} match={1} approved_divergence={2} replicate_legacy={3} pending_mismatch={4} specification_pending={5} unexpected={6} stale={7} error={8} registry_errors={9}" -f $units.Count, $counts.match, $counts.approved_divergence, $counts.mismatch_replicate_legacy, $counts.mismatch_decision_pending, $counts.specification_decision_pending, $counts.unexpected_mismatch, $counts.stale_registry_entry, $counts.error, $registryErrors.Count)
Write-Host ("boundary: match={0} mismatch={1} not_executed={2}" -f $bcCounts.match, $bcCounts.mismatch, $bcCounts.not_executed)
Write-Host ("gate: " + $(if ($gateFail) { 'FAIL' } else { 'PASS' }))
if ($gateFail) { exit 1 } else { exit 0 }