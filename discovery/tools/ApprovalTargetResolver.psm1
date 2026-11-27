#Requires -Version 7.0
# Resolution of `run:` and `claim:` approval targets (task 4.10, step B3b; R23.1, R23.7, R23.8, R23.12, R6.9, R12.23).
#
# Reads only. This module opens nothing for writing, never touches the Approval_Store, and never starts a process. It has no
# command-line surface: the runs root is a parameter of the functions below, and the only caller that ships (Add-ApprovalRecord.ps1)
# passes the fixed runs directory of the repository. Nothing in a result, a code, or an error carries a path, a hash, a manifest value,
# a record, or an exception message: failures are the fixed codes listed here.
#
# How a target is resolved:
#   1. The target is checked for its exact shape, the Run id for the exact generated form `run-<yyyyMMddTHHmmssZ>-<12 lower-case hex>`
#      (`\A...\z`, a real calendar date and time, no trailing line feed), and the Claim revision id for the generated form
#      `clm-<4 or more digits>-r<n>`. All of this happens BEFORE any file is opened.
#   2. The Run directory `<runs root>/<run id>` is verified ONCE per check with the bounded verification of DiscoveryCommon.psm1:
#      Test-RunDirectory -Bounded -RequireMarker -RejectReparsePoints -IncludeVerifiedData (all four are needed; -Bounded alone does not
#      check links). The limits are the defaults of that function (64 MiB of raw bytes read in total, manifest 4 MiB, COMPLETE 128 bytes,
#      10000 entries, depth 16). They are not raised, and there is no fallback to an unbounded verification. A valid Run can exceed them
#      and is then refused as an approval target. The result is used from `VerifiedData` only; the manifest and records.jsonl are not
#      read again.
#   3. manifest.runId must equal the Run id of the target.
#   4. The records.jsonl bytes of the verified read are parsed line by line with ConvertFrom-JsonStrict (a duplicate key throws), for a Run
#      and for a Claim target. Every line must be a strict RecordEnvelope; a bad line makes the check fail, nothing is skipped. For a Claim
#      target, every `hypothesis_revision` record must carry a valid payload.claims list, and the Claim revision must occur exactly once in the Run.
#      Any earlier revision is a valid target; there is no "latest only" rule.
#
# Manifest identity: New-ApprovalTargetControl performs the first verification and keeps the SHA-256 of the verified manifest. The
# TargetResolver scriptblock that it returns runs a second, independent bounded verification (it is called by the store layer under the
# store mutex, after the store has been verified and immediately before the final comparison of the store bytes and the atomic write) and
# requires the same manifest hash, and the explicit -ExpectManifestSha256 when one was given. A bare `true` from a second verification is
# not enough. The manifest hash is NOT stored in the Approval_Record (the record schema is unchanged); it is held in memory for these two checks only.
#
# What this does NOT give: the store mutex does not stop a change of the Run; a replacement between the check and the open, a hard
# link, a subst or mapped drive, and a change after the second verification and before the write are not detected. The acceptance of the PowerShell check and of the
# TypeScript readers is not equivalent (the record envelope is checked here; the full manifest schema and the full record payload
# schemas are not).
Set-StrictMode -Version Latest
Import-Module (Join-Path $PSScriptRoot 'DiscoveryCommon.psm1') -DisableNameChecking

$script:Utf8Strict = [System.Text.UTF8Encoding]::new($false, $true)
$script:Genesis = '0' * 64
$script:IdPattern = '\A[a-z][a-z0-9-]{0,63}\z'
# RECORD_KINDS of packages/discovery-loop/src/schema/schemas.ts (the record-envelope schema). A static test compares the two lists.
$script:RecordKinds = @(
    'run_started', 'isolation_checks', 'source_bundle_manifest', 'payload_audit', 'ai_call', 'ai_output', 'ai_rejected',
    'ai_content_discarded', 'hypothesis_revision', 'citation_verification', 'experiment', 'experiment_invalid',
    'policy_decision', 'experiment_dropped', 'observation', 'comparison', 'evidence', 'store_rejection', 'lease_event',
    'termination', 'error'
)
$script:Codes = @(
    'ok', 'target_invalid', 'run_id_invalid', 'claim_id_invalid', 'expected_hash_invalid', 'run_not_verified', 'verified_data_missing',
    'verified_data_invalid', 'manifest_run_id_mismatch', 'manifest_changed', 'manifest_hash_mismatch', 'records_invalid',
    'claim_record_invalid', 'claim_not_found', 'claim_ambiguous', 'verification_error', 'check_error', 'target_mismatch'
)

function Get-ApprovalRecordKinds { , @($script:RecordKinds) }
function Get-ApprovalTargetCodes { , @($script:Codes) }

function Test-ApprovalRunId {
    param($RunId)
    if ($RunId -isnot [string]) { return $false }
    if (-not ($RunId -cmatch '\Arun-([0-9]{8}T[0-9]{6}Z)-[0-9a-f]{12}\z')) { return $false }
    $stamp = $Matches[1]
    $dt = [datetime]::MinValue
    [datetime]::TryParseExact($stamp, "yyyyMMdd'T'HHmmss'Z'", [System.Globalization.CultureInfo]::InvariantCulture, [System.Globalization.DateTimeStyles]::None, [ref]$dt)
}

# The generated form of a Claim revision id: clm-<counter, at least 4 digits>-r<revision from 1>, at most 64 characters (the Id pattern).
function Test-ApprovalClaimRevisionId {
    param($Id)
    ($Id -is [string]) -and $Id.Length -le 64 -and ($Id -cmatch '\Aclm-[0-9]{4,}-r[1-9][0-9]*\z')
}

function Test-ApprovalSha256 {
    param($Value)
    ($Value -is [string]) -and ($Value -cmatch '\A[0-9a-f]{64}\z')
}

# Every key of the dictionary is required or optional, and every required key is present. Case-sensitive.
function Test-ApprovalKeySet {
    param($Dictionary, [string[]]$Required, [string[]]$Optional = @())
    if ($Dictionary -isnot [System.Collections.IDictionary]) { return $false }
    foreach ($k in $Dictionary.Keys) { if (($Required -cnotcontains [string]$k) -and ($Optional -cnotcontains [string]$k)) { return $false } }
    foreach ($k in $Required) { if (-not $Dictionary.Contains($k)) { return $false } }
    $true
}

# VerifiedData.RecordsBytes in its PowerShell representation: DiscoveryCommon.psm1 assigns the bytes through an `if` expression, which
# unrolls the array, so the value arrives as object[] whose elements are [byte] (or as a single [byte] for a one-byte file, or $null).
# Accepted: byte[] as it is; an array whose every element IS a [byte] (no integer, string or other value is converted), copied once into a
# byte[] of the same length and order; a single [byte]. $null (an existing property with the value $null) is a Run verified with zero
# records, in one of two forms that the bounded verification accepts: (a) records.jsonl is listed and present with 0 bytes, or (b)
# records.jsonl is neither listed nor present, with chain.records 0 and lastHash genesis (the form the TypeScript writer produces for a Run
# without records). Both become an empty byte[], which the record reader accepts as zero records. A missing property is not $null: it
# throws under strict mode and the check is refused. Anything else returns $null here, and the caller refuses with verified_data_invalid.
# Nothing is read again.
function ConvertTo-ApprovalVerifiedBytes {
    param($Value)
    if ($null -eq $Value) { return , ([byte[]]::new(0)) }
    if ($Value -is [byte[]]) { return , $Value }
    if ($Value -is [byte]) { return , ([byte[]]@($Value)) }
    if ($Value -isnot [object[]]) { return $null }
    $out = [byte[]]::new($Value.Length)
    for ($i = 0; $i -lt $Value.Length; $i++) {
        $b = $Value[$i]
        if ($b -isnot [byte]) { return $null }
        $out[$i] = $b
    }
    , $out
}

function New-TargetResult {
    param([bool]$Ok, [string]$Code, $ManifestSha256 = $null)
    [pscustomobject]@{ Ok = $Ok; Code = $Code; ManifestSha256 = $ManifestSha256 }
}

# One strict record envelope (packages/discovery-loop/src/schema/schemas.ts, record-envelope): exactly schemaVersion 1, seq, id, kind,
# prevHash, payload, hash. $Seq is the expected position; $PrevHash the hash of the record before it (genesis for the first).
function Test-ApprovalRecordEnvelope {
    param($Record, [long]$Seq, [string]$PrevHash)
    if (-not (Test-ApprovalKeySet $Record @('schemaVersion', 'seq', 'id', 'kind', 'prevHash', 'payload', 'hash'))) { return $false }
    if ($Record['schemaVersion'] -isnot [long] -or $Record['schemaVersion'] -ne 1) { return $false }
    if ($Record['seq'] -isnot [long] -or $Record['seq'] -ne $Seq) { return $false }
    if ($Record['id'] -isnot [string] -or $Record['id'] -cne ('rec-{0:D6}' -f $Seq)) { return $false }
    if ($Record['kind'] -isnot [string] -or $script:RecordKinds -cnotcontains $Record['kind']) { return $false }
    if (-not (Test-ApprovalSha256 $Record['prevHash']) -or $Record['prevHash'] -cne $PrevHash) { return $false }
    if (-not (Test-ApprovalSha256 $Record['hash'])) { return $false }
    if ($Record['payload'] -isnot [System.Collections.IDictionary]) { return $false }
    $true
}

# Parses the verified records.jsonl bytes. Any line that is not a strict envelope makes the whole result a failure; no line is skipped.
# Returns Ok, Code, Records (a list of the parsed dictionaries). The chain hashes were already verified by the bounded verification.
function Read-ApprovalRunRecords {
    [CmdletBinding()]
    param([Parameter(Mandatory)][AllowEmptyCollection()][byte[]]$RecordsBytes)
    $records = [System.Collections.Generic.List[object]]::new()
    $fail = [pscustomobject]@{ Ok = $false; Code = 'records_invalid'; Records = $records }
    try { $text = $script:Utf8Strict.GetString($RecordsBytes) } catch { return $fail }
    if ($text.Length -eq 0) { return [pscustomobject]@{ Ok = $true; Code = 'ok'; Records = $records } }
    if (-not $text.EndsWith("`n", [System.StringComparison]::Ordinal)) { return $fail }
    $lines = $text.Substring(0, $text.Length - 1).Split("`n")
    $prev = $script:Genesis
    $n = [long]0
    foreach ($line in $lines) {
        $n++
        try { $rec = ConvertFrom-JsonStrict -Text $line } catch { return $fail }
        if (-not (Test-ApprovalRecordEnvelope -Record $rec -Seq $n -PrevHash $prev)) { return $fail }
        $prev = [string]$rec['hash']
        $records.Add($rec)
    }
    [pscustomobject]@{ Ok = $true; Code = 'ok'; Records = $records }
}

# One entry of payload.claims of a hypothesis_revision record (hypothesisPhase.ts, claimEntries; EvidenceStore.createClaimRevision).
function Test-ApprovalClaimEntry {
    param($Entry)
    if (-not (Test-ApprovalKeySet $Entry @('claimId', 'claimRevisionId', 'revision', 'semanticSha256', 'claim', 'aiStated', 'origin') @('predecessorRevision'))) { return $false }
    $cid = $Entry['claimId']; $crid = $Entry['claimRevisionId']; $rev = $Entry['revision']
    if ($cid -isnot [string] -or $cid -cnotmatch $script:IdPattern) { return $false }
    if ($rev -isnot [long] -or $rev -lt 1) { return $false }
    if ($crid -isnot [string] -or $crid -cnotmatch $script:IdPattern -or $crid -cne ($cid + '-r' + [string]$rev)) { return $false }
    if ($Entry.Contains('predecessorRevision')) {
        $p = $Entry['predecessorRevision']
        if ($p -isnot [long] -or $p -lt 1 -or $p -ge $rev) { return $false }
    }
    if (-not (Test-ApprovalSha256 $Entry['semanticSha256'])) { return $false }
    if ($Entry['claim'] -isnot [System.Collections.IDictionary]) { return $false }
    $stated = $Entry['aiStated']
    if (-not (Test-ApprovalKeySet $stated @('confidence', 'openQuestions'))) { return $false }
    if ($stated['confidence'] -isnot [string] -or @('low', 'medium', 'high') -cnotcontains $stated['confidence']) { return $false }
    $oq = $stated['openQuestions']
    if ($oq -isnot [System.Collections.IList]) { return $false }
    foreach ($q in $oq) { if ($q -isnot [string]) { return $false } }
    if ($Entry['origin'] -isnot [string] -or $Entry['origin'] -cne 'ai-inferred') { return $false }
    $true
}

# Resolves one Claim revision id among the parsed records. Every hypothesis_revision record is validated, not only the one that holds the
# target (a bad related record refuses the Run). Any revision id that occurs twice in the Run is ambiguous.
function Find-ApprovalClaimRevision {
    [CmdletBinding()]
    param([Parameter(Mandatory)]$Records, [Parameter(Mandatory)][string]$ClaimRevisionId)
    $seen = [System.Collections.Generic.HashSet[string]]::new([System.StringComparer]::Ordinal)
    $duplicate = $false
    $matchCount = 0
    foreach ($r in @($Records)) {
        if ($r['kind'] -cne 'hypothesis_revision') { continue }
        $claims = $r['payload']['claims']
        if ($claims -isnot [System.Collections.IList] -or $claims.Count -lt 1 -or $claims.Count -gt 50) { return (New-TargetResult $false 'claim_record_invalid') }
        foreach ($e in $claims) {
            if (-not (Test-ApprovalClaimEntry -Entry $e)) { return (New-TargetResult $false 'claim_record_invalid') }
            $id = [string]$e['claimRevisionId']
            if (-not $seen.Add($id)) { $duplicate = $true }
            if ($id -ceq $ClaimRevisionId) { $matchCount++ }
        }
    }
    if ($duplicate) { return (New-TargetResult $false 'claim_ambiguous') }
    if ($matchCount -eq 0) { return (New-TargetResult $false 'claim_not_found') }
    New-TargetResult $true 'ok'
}

# One check of one target: exactly one bounded verification of <RunsRoot>/<run id>. -PinnedManifestSha256 is the hash of the first
# verification (the second check passes it); -ExpectManifestSha256 is the human's expectation. Both are compared with the manifest hash of
# THIS verification. Returns Ok, Code (fixed), ManifestSha256 (only when Ok).
function Invoke-ApprovalTargetCheck {
    [CmdletBinding()]
    param([Parameter(Mandatory)]$Target, [Parameter(Mandatory)][string]$RunsRoot, [string]$ExpectManifestSha256, [string]$PinnedManifestSha256)
    try {
        if ($Target -isnot [System.Collections.IDictionary] -or $Target['kind'] -isnot [string]) { return (New-TargetResult $false 'target_invalid') }
        $isClaim = $false
        if ($Target['kind'] -ceq 'run') { if (-not (Test-ApprovalKeySet $Target @('kind', 'run_id'))) { return (New-TargetResult $false 'target_invalid') } }
        elseif ($Target['kind'] -ceq 'claim_revision') {
            if (-not (Test-ApprovalKeySet $Target @('kind', 'run_id', 'claim_revision_id'))) { return (New-TargetResult $false 'target_invalid') }
            $isClaim = $true
        } else { return (New-TargetResult $false 'target_invalid') }
        $runId = $Target['run_id']
        if (-not (Test-ApprovalRunId $runId)) { return (New-TargetResult $false 'run_id_invalid') }
        if ($isClaim -and -not (Test-ApprovalClaimRevisionId $Target['claim_revision_id'])) { return (New-TargetResult $false 'claim_id_invalid') }
        $hasExpect = $PSBoundParameters.ContainsKey('ExpectManifestSha256')
        $hasPinned = $PSBoundParameters.ContainsKey('PinnedManifestSha256')
        if (($hasExpect -and -not (Test-ApprovalSha256 $ExpectManifestSha256)) -or ($hasPinned -and -not (Test-ApprovalSha256 $PinnedManifestSha256))) { return (New-TargetResult $false 'expected_hash_invalid') }

        $dir = Join-Path $RunsRoot $runId
        try { $v = Test-RunDirectory -Path $dir -Bounded -RequireMarker -RejectReparsePoints -IncludeVerifiedData } catch { return (New-TargetResult $false 'verification_error') }
        if ($v.Incomplete -or $v.Result -cne 'success') { return (New-TargetResult $false 'run_not_verified') }
        $vd = $v.VerifiedData
        if ($null -eq $vd) { return (New-TargetResult $false 'verified_data_missing') }
        if (-not (Test-ApprovalSha256 $vd.ManifestSha256) -or $vd.MarkerMatchesManifest -ne $true -or $vd.Manifest -isnot [System.Collections.IDictionary]) { return (New-TargetResult $false 'verified_data_invalid') }
        $m = $vd.Manifest
        if (-not $m.Contains('runId') -or $m['runId'] -isnot [string] -or $m['runId'] -cne $runId) { return (New-TargetResult $false 'manifest_run_id_mismatch') }
        if ($hasPinned -and $vd.ManifestSha256 -cne $PinnedManifestSha256) { return (New-TargetResult $false 'manifest_changed') }
        if ($hasExpect -and $vd.ManifestSha256 -cne $ExpectManifestSha256) { return (New-TargetResult $false 'manifest_hash_mismatch') }
        # The records of the verified read are parsed for both target kinds: a Run whose records are not strict envelopes is not a target.
        $recordsBytes = ConvertTo-ApprovalVerifiedBytes -Value $vd.RecordsBytes
        if ($null -eq $recordsBytes) { return (New-TargetResult $false 'verified_data_invalid') }
        $parsed = Read-ApprovalRunRecords -RecordsBytes $recordsBytes
        if (-not $parsed.Ok) { return (New-TargetResult $false $parsed.Code) }
        if ($isClaim) {
            $found = Find-ApprovalClaimRevision -Records $parsed.Records -ClaimRevisionId ([string]$Target['claim_revision_id'])
            if (-not $found.Ok) { return $found }
        }
        New-TargetResult $true 'ok' $vd.ManifestSha256
    } catch {
        New-TargetResult $false 'check_error'
    }
}

# The first verification now, and the bool TargetResolver for the store layer. The scriptblock repeats the check (a second, independent
# bounded verification) when the store calls it and requires the manifest hash of the first verification (and the expected hash, when one
# was given). It returns only $true or $false; State holds the fixed last code and the counters (for the command output and the tests).
function New-ApprovalTargetControl {
    [CmdletBinding()]
    param([Parameter(Mandatory)]$Target, [Parameter(Mandatory)][string]$RunsRoot, [string]$ExpectManifestSha256)
    $expArgs = @{}
    if ($PSBoundParameters.ContainsKey('ExpectManifestSha256')) { $expArgs['ExpectManifestSha256'] = $ExpectManifestSha256 }
    $state = [pscustomobject]@{ FirstOk = $false; FirstCode = ''; PinnedManifestSha256 = $null; LastCode = ''; ResolverCalls = 0; Verifications = 0 }
    $first = Invoke-ApprovalTargetCheck -Target $Target -RunsRoot $RunsRoot @expArgs
    $state.Verifications = 1
    if ($first.Ok) { $state.FirstOk = $true; $state.PinnedManifestSha256 = $first.ManifestSha256 }
    else { $state.FirstCode = $first.Code; $state.LastCode = $first.Code }
    $targetText = ''
    try { $targetText = ConvertTo-CanonicalJson -Value $Target } catch { $targetText = $null }
    $checkCmd = Get-Command -Name Invoke-ApprovalTargetCheck -CommandType Function
    $canonCmd = Get-Command -Name ConvertTo-CanonicalJson
    $resolver = {
        param($t)
        $state.ResolverCalls = $state.ResolverCalls + 1
        $same = $false
        try { $same = ($null -ne $targetText) -and ((& $canonCmd -Value $t) -ceq $targetText) } catch { $same = $false }
        if (-not $same) { $state.LastCode = 'target_mismatch'; return $false }
        if (-not $state.FirstOk) { $state.LastCode = $state.FirstCode; return $false }
        $r = & $checkCmd -Target $t -RunsRoot $RunsRoot -PinnedManifestSha256 $state.PinnedManifestSha256 @expArgs
        $state.Verifications = $state.Verifications + 1
        $state.LastCode = [string]$r.Code
        return [bool]$r.Ok
    }.GetNewClosure()
    [pscustomobject]@{ Resolver = $resolver; State = $state }
}

Export-ModuleMember -Function Get-ApprovalRecordKinds, Get-ApprovalTargetCodes, Test-ApprovalRunId, Test-ApprovalClaimRevisionId, Read-ApprovalRunRecords, Find-ApprovalClaimRevision, Invoke-ApprovalTargetCheck, New-ApprovalTargetControl
