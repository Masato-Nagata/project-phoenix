#Requires -Version 7.0
# Approval_Store, host-side writer and reader (task 2.25; design "Approval_Store (R23)", C11; R23.1 to R23.14, R18.20).
#
# This module is the ONLY code that opens the store file for writing (a static test checks it). Every write goes through
# Invoke-ApprovalStoreRequest, which receives a request with an explicit operation:
#   append  - add a new Approval_Record. Valid: stored. Invalid under R23.7: refused with every field named, store byte-identical.
#   modify  - refused; one store_rejection line (reason modify_refused) is appended; stored lines are unchanged.
#   delete  - the same, with the reason delete_refused.
#   other   - refused, store byte-identical, no line.
# The chain is verified before every write. A damaged chain is reported and not extended. Every write takes the store mutex and
# replaces the file atomically (temporary file, flush, File.Replace).
#
# What this does NOT give (residual risks, status unresolved): the hash chain detects edits, it does not prevent them; without an
# external anchor (task 4.10) removal of trailing records is not detected; `recorded_by` is a declaration, not an authenticated
# identity. A zero exit status of a verification means "no mismatch among the records present", not "the store is complete".
Set-StrictMode -Version Latest
Import-Module (Join-Path $PSScriptRoot 'DiscoveryCommon.psm1') -DisableNameChecking

$script:StoreMutexName = 'Local\ProjectPhoenixApprovalStore'
$script:Genesis = '0' * 64
$script:Utf8 = [System.Text.UTF8Encoding]::new($false)
$script:Utf8Strict = [System.Text.UTF8Encoding]::new($false, $true)
$script:GateIds = @('start-implementation', 'container-runtime', 'override-draft', 'override-apply', 'install-kiro-cli', 'm6-start', 'm7-start', 'transmit-source', 'm0-checkpoint-exception')   # the last one: R21.20, one-time M0 checkpoint exception for the M3 start only
$script:Decisions = @('approved', 'rejected', 'needs_changes')
$script:Actors = @('human', 'kiro-development-agent')
$script:CandidateFields = @('approver', 'timestamp', 'target', 'decision', 'rationale', 'recorded_by', 'supersedes')

function Get-ApprovalGateIds { , $script:GateIds }

# ---------------------------------------------------------------------------------------------------------------------
# Schema of a stored line (the approval-record schema of M1, ported).
function Test-IsoTimestamp {
    param($Value)
    if ($Value -isnot [string]) { return $false }
    $m = [regex]::Match($Value, '^([0-9]{4})-([0-9]{2})-([0-9]{2})T([0-9]{2}):([0-9]{2}):([0-9]{2})(?:\.[0-9]+)?(?:Z|[+-]([0-9]{2}):([0-9]{2}))$')
    if (-not $m.Success) { return $false }
    $y = [int]$m.Groups[1].Value; $mo = [int]$m.Groups[2].Value; $d = [int]$m.Groups[3].Value
    $hh = [int]$m.Groups[4].Value; $mi = [int]$m.Groups[5].Value; $ss = [int]$m.Groups[6].Value
    if ($mo -lt 1 -or $mo -gt 12 -or $hh -gt 23 -or $mi -gt 59 -or $ss -gt 60) { return $false }
    $leap = ($y % 4 -eq 0) -and (($y % 100 -ne 0) -or ($y % 400 -eq 0))
    $dim = @(31, $(if ($leap) { 29 } else { 28 }), 31, 30, 31, 30, 31, 31, 30, 31, 30, 31)[$mo - 1]
    if ($d -lt 1 -or $d -gt $dim) { return $false }
    if ($m.Groups[7].Success) {
        if ([int]$m.Groups[7].Value -gt 23 -or [int]$m.Groups[8].Value -gt 59) { return $false }
    }
    $true
}

function Test-IsInteger {
    param($Value, [long]$Minimum = 1)
    ($Value -is [long] -or $Value -is [int]) -and [long]$Value -ge $Minimum
}

function Test-TargetShape {
    param($Target)
    if ($Target -isnot [System.Collections.IDictionary]) { return $false }
    $keys = @($Target.Keys | ForEach-Object { [string]$_ } | Sort-Object -CaseSensitive)
    $kind = $Target['kind']
    if ($kind -isnot [string]) { return $false }
    $runIdOk = { param($v) $v -is [string] -and $v -cmatch '^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$' }
    switch -CaseSensitive ($kind) {
        'run' { return ((($keys -join ',') -ceq 'kind,run_id') -and (& $runIdOk $Target['run_id'])) }
        'claim_revision' { return ((($keys -join ',') -ceq 'claim_revision_id,kind,run_id') -and (& $runIdOk $Target['run_id']) -and $Target['claim_revision_id'] -is [string] -and $Target['claim_revision_id'] -cmatch '^[a-z][a-z0-9-]{0,63}$') }
        'gate' { return ((($keys -join ',') -ceq 'gate_id,kind') -and $Target['gate_id'] -is [string] -and ($script:GateIds -ccontains $Target['gate_id'])) }
        default { return $false }
    }
}

function Test-Sha256Field {
    param($Value)
    $Value -is [string] -and $Value -cmatch '^[0-9a-f]{64}$'
}

# Returns the names of the fields that do not satisfy the schema of a stored line ($null when the line is valid).
function Get-StoredLineSchemaProblems {
    param($Line)
    $problems = [System.Collections.Generic.List[string]]::new()
    if ($Line -isnot [System.Collections.IDictionary]) { $problems.Add('(record)'); return , $problems }
    $type = $Line['type']
    if ($type -ceq 'approval') {
        $allowed = @('type', 'seq', 'prev_hash', 'approver', 'timestamp', 'target', 'decision', 'rationale', 'recorded_by', 'supersedes', 'hash')
        $required = @('type', 'seq', 'prev_hash', 'approver', 'timestamp', 'target', 'decision', 'rationale', 'recorded_by', 'hash')
    } elseif ($type -ceq 'store_rejection') {
        $allowed = @('type', 'seq', 'prev_hash', 'reason', 'attempted_seq', 'hash')
        $required = @('type', 'seq', 'prev_hash', 'reason', 'hash')
    } else { $problems.Add('type'); return , $problems }
    foreach ($k in $Line.Keys) { if ($allowed -cnotcontains [string]$k) { $problems.Add([string]$k) } }
    foreach ($k in $required) { if (-not $Line.Contains($k)) { $problems.Add($k) } }
    if ($problems.Count -gt 0) { return , $problems }
    if (-not (Test-IsInteger $Line['seq'])) { $problems.Add('seq') }
    if (-not (Test-Sha256Field $Line['prev_hash'])) { $problems.Add('prev_hash') }
    if (-not (Test-Sha256Field $Line['hash'])) { $problems.Add('hash') }
    if ($type -ceq 'approval') {
        $a = $Line['approver']
        if ($a -isnot [string] -or (Get-CodePointCount $a) -lt 1 -or (Get-CodePointCount $a) -gt 100) { $problems.Add('approver') }
        if (-not (Test-IsoTimestamp $Line['timestamp'])) { $problems.Add('timestamp') }
        if (-not (Test-TargetShape $Line['target'])) { $problems.Add('target') }
        if ($Line['decision'] -isnot [string] -or $script:Decisions -cnotcontains $Line['decision']) { $problems.Add('decision') }
        $r = $Line['rationale']
        if ($r -isnot [string] -or (Get-CodePointCount $r) -lt 1 -or (Get-CodePointCount $r) -gt 2000 -or -not (Test-HasNonJsWhitespace $r)) { $problems.Add('rationale') }
        if ($Line['recorded_by'] -isnot [string] -or $script:Actors -cnotcontains $Line['recorded_by']) { $problems.Add('recorded_by') }
        if ($Line.Contains('supersedes') -and -not (Test-IsInteger $Line['supersedes'])) { $problems.Add('supersedes') }
    } else {
        $rs = $Line['reason']
        if ($rs -isnot [string] -or (Get-CodePointCount $rs) -lt 1 -or (Get-CodePointCount $rs) -gt 500) { $problems.Add('reason') }
        if ($Line.Contains('attempted_seq') -and -not (Test-IsInteger $Line['attempted_seq'])) { $problems.Add('attempted_seq') }
    }
    , $problems
}

# ---------------------------------------------------------------------------------------------------------------------
# Chain: line hash, line text, and the analysis of a whole store (the analyzeStore function of M1, ported).
function Get-StoredLineHash {
    param([System.Collections.IDictionary]$Line)
    $rest = [ordered]@{}
    foreach ($k in $Line.Keys) { if ([string]$k -cne 'hash') { $rest[[string]$k] = $Line[$k] } }
    Get-Sha256HexOfText -Text (ConvertTo-CanonicalJson -Value $rest)
}

function ConvertTo-StoredLineText {
    param([System.Collections.IDictionary]$Line)
    (ConvertTo-CanonicalJson -Value $Line) + "`n"
}

function Test-SameTarget {
    param($A, $B)
    (ConvertTo-CanonicalJson -Value $A) -ceq (ConvertTo-CanonicalJson -Value $B)
}

function Get-KindOrder {
    param([string]$Kind)
    switch ($Kind) { 'modified' { 0 } 'missing' { 1 } default { 2 } }
}

function Get-ApprovalStoreAnalysis {
    [CmdletBinding()]
    param([Parameter(Mandatory)][AllowEmptyCollection()][byte[]]$Bytes, $Anchor)
    $mismatches = [System.Collections.Generic.List[object]]::new()
    $violations = [System.Collections.Generic.List[object]]::new()
    $lines = [System.Collections.Generic.List[object]]::new()
    $approvals = [System.Collections.Generic.Dictionary[long, object]]::new()
    $supersededBy = [System.Collections.Generic.Dictionary[long, long]]::new()
    $seen = [System.Collections.Generic.HashSet[string]]::new()
    $add = {
        param([long]$seq, [string]$kind, [string]$detail)
        if ($seen.Add("${seq}:$kind")) { $mismatches.Add([pscustomobject]@{ Seq = $seq; Kind = $kind; Detail = $detail }) }
    }

    $text = $null
    try { $text = $script:Utf8Strict.GetString($Bytes) } catch { & $add 1 'modified' 'the store is not valid UTF-8' }
    $lineTexts = [System.Collections.Generic.List[string]]::new()
    $unterminated = $false
    if ($null -ne $text -and $text.Length -gt 0) {
        foreach ($p in $text.Split("`n")) { $lineTexts.Add($p) }
        $last = $lineTexts[$lineTexts.Count - 1]
        $lineTexts.RemoveAt($lineTexts.Count - 1)
        if ($last -ne '') { $lineTexts.Add($last); $unterminated = $true }
    }

    [long]$expected = 1
    $prevHash = $script:Genesis
    for ($i = 0; $i -lt $lineTexts.Count; $i++) {
        $lineText = $lineTexts[$i]
        $isUnterminated = $unterminated -and $i -eq ($lineTexts.Count - 1)
        $rec = $null
        $why = $null
        try {
            $parsed = ConvertFrom-JsonStrict -Text $lineText
            if ((ConvertTo-CanonicalJson -Value $parsed) -cne $lineText) { $why = 'not canonical' }
            else {
                $problems = Get-StoredLineSchemaProblems -Line $parsed
                if ($problems.Count -gt 0) { $why = 'schema: ' + ($problems -join ', ') } else { $rec = $parsed }
            }
        } catch { $why = $_.Exception.Message }
        if ($null -eq $rec) {
            & $add $expected 'modified' "line $($i + 1) is not a canonical, valid line ($why)"
            $prevHash = $null
            $expected++
            continue
        }
        [long]$seq = $rec['seq']
        if ($seq -gt $expected) {
            & $add $expected 'missing' $(if ($seq - 1 -eq $expected) { "record $expected is absent" } else { "records $expected to $($seq - 1) are absent" })
            $expected = $seq
        } elseif ($seq -lt $expected) {
            & $add $seq 'chain_break' "sequence number $seq repeats or goes backwards (expected $expected)"
        }
        if ((Get-StoredLineHash -Line $rec) -cne $rec['hash']) { & $add $seq 'modified' 'hash is not the hash of the record content' }
        if ($isUnterminated) { & $add $seq 'modified' 'last line is not newline-terminated (partial write)' }
        if ($null -ne $prevHash -and $rec['prev_hash'] -cne $prevHash) { & $add $seq 'chain_break' 'prev_hash is not the hash of the preceding line' }
        $prevHash = $rec['hash']
        $expected = [Math]::Max($expected, $seq + 1)
        $lines.Add($rec)

        if ($rec['type'] -ceq 'approval') {
            if ($rec.Contains('supersedes')) {
                [long]$sup = $rec['supersedes']
                $target = $null
                if ($approvals.ContainsKey($sup)) { $target = $approvals[$sup] }
                $earlierExists = $false
                foreach ($l in $lines) { if (-not [object]::ReferenceEquals($l, $rec) -and [long]$l['seq'] -eq $sup) { $earlierExists = $true } }
                if ($null -eq $target) {
                    $violations.Add($(if ($earlierExists) { [pscustomobject]@{ Seq = $seq; Rule = 'supersedes_not_approval'; Detail = "record $sup is not an approval" } } else { [pscustomobject]@{ Seq = $seq; Rule = 'supersedes_unknown'; Detail = "no earlier record $sup" } }))
                } elseif (-not (Test-SameTarget $target['target'] $rec['target'])) {
                    $violations.Add([pscustomobject]@{ Seq = $seq; Rule = 'supersedes_target_differs'; Detail = "record $sup has another target" })
                } elseif ($supersededBy.ContainsKey($sup)) {
                    $violations.Add([pscustomobject]@{ Seq = $seq; Rule = 'supersedes_already_superseded'; Detail = "record $sup is already superseded by $($supersededBy[$sup])" })
                } else { $supersededBy[$sup] = $seq }
            }
            $approvals[$seq] = $rec
        }
    }

    if ($null -ne $Anchor) {
        $at = $null
        foreach ($l in $lines) { if ([long]$l['seq'] -eq [long]$Anchor.seq) { $at = $l } }
        if ($null -eq $at) { & $add ([long]$Anchor.seq) 'missing' "anchored record $($Anchor.seq) is not in the store" }
        elseif ($at['hash'] -cne $Anchor.hash) { & $add ([long]$Anchor.seq) 'modified' 'hash differs from the anchored hash' }
    }

    $sorted = @($mismatches | Sort-Object -Property @{ Expression = { $_.Seq } }, @{ Expression = { Get-KindOrder $_.Kind } })
    $sortedViolations = @($violations | Sort-Object -Property @{ Expression = { $_.Seq } })
    $ok = ($sorted.Count -eq 0 -and $sortedViolations.Count -eq 0)
    $lastLine = if ($lines.Count -gt 0) { $lines[$lines.Count - 1] } else { $null }
    [pscustomobject]@{
        Ok = $ok
        LineCount = $lineTexts.Count
        Mismatches = $sorted
        RuleViolations = $sortedViolations
        TailTruncation = $(if ($null -ne $Anchor -and $ok) { 'excluded_by_anchor' } else { 'not_checked' })
        Lines = $lines
        Approvals = $approvals
        SupersededBy = $supersededBy
        NextSeq = $(if ($null -eq $lastLine) { [long]1 } else { [long]$lastLine['seq'] + 1 })
        LastHash = $(if ($null -eq $lastLine) { $script:Genesis } else { [string]$lastLine['hash'] })
    }
}

# ---------------------------------------------------------------------------------------------------------------------
# Validation of a candidate for a new approval line (R23.7, R23.12; validateApprovalCandidate of M1, ported).
# $TargetResolver decides whether a run or claim target exists. The default resolves nothing: while no Run exists (task 2.25),
# a run: or claim: target is rejected as unresolvable. A scriptblock is accepted only in-process, for tests.
function Test-ApprovalCandidate {
    [CmdletBinding()]
    param($Candidate, [Parameter(Mandatory)]$Analysis, [scriptblock]$TargetResolver)
    $issues = [System.Collections.Generic.List[object]]::new()
    $addIssue = { param($field, $code, $message) $issues.Add([pscustomobject]@{ Field = $field; Code = $code; Message = $message }) }
    if ($Candidate -isnot [System.Collections.IDictionary]) {
        & $addIssue '(record)' 'not_an_object' 'the record must be an object'
        return , @($issues)
    }
    $content = [ordered]@{}
    foreach ($k in $Candidate.Keys) {
        if ($script:CandidateFields -ccontains [string]$k) { if ($null -ne $Candidate[$k]) { $content[[string]$k] = $Candidate[$k] } }
        else { & $addIssue ([string]$k) 'undefined_field' 'field is not caller-supplied or not defined' }
    }
    foreach ($k in @('approver', 'timestamp', 'target', 'decision', 'rationale', 'recorded_by')) {
        if (-not $content.Contains($k)) { & $addIssue $k 'missing_field' 'required field is missing' }
    }
    $bad = { param($field) & $addIssue $field 'bad_value' 'the value is not valid' }
    if ($content.Contains('approver')) {
        $a = $content['approver']
        if ($a -isnot [string] -or (Get-CodePointCount $a) -lt 1 -or (Get-CodePointCount $a) -gt 100) { & $bad 'approver' }
    }
    if ($content.Contains('timestamp') -and -not (Test-IsoTimestamp $content['timestamp'])) { & $bad 'timestamp' }
    if ($content.Contains('target') -and -not (Test-TargetShape $content['target'])) { & $bad 'target' }
    if ($content.Contains('decision') -and ($content['decision'] -isnot [string] -or $script:Decisions -cnotcontains $content['decision'])) { & $bad 'decision' }
    if ($content.Contains('rationale')) {
        $r = $content['rationale']
        if ($r -isnot [string] -or (Get-CodePointCount $r) -lt 1 -or (Get-CodePointCount $r) -gt 2000 -or -not (Test-HasNonJsWhitespace $r)) { & $bad 'rationale' }
    }
    if ($content.Contains('recorded_by') -and ($content['recorded_by'] -isnot [string] -or $script:Actors -cnotcontains $content['recorded_by'])) { & $bad 'recorded_by' }
    if ($content.Contains('supersedes') -and -not (Test-IsInteger $content['supersedes'])) { & $bad 'supersedes' }

    $failed = @($issues | ForEach-Object { $_.Field })
    $targetOk = $content.Contains('target') -and ($failed -cnotcontains 'target')
    $supersedesOk = $content.Contains('supersedes') -and ($failed -cnotcontains 'supersedes')
    $supersedesProblem = {
        param([long]$s)
        $isOther = $false
        foreach ($l in $Analysis.Lines) { if ([long]$l['seq'] -eq $s) { $isOther = $true } }
        & $addIssue 'supersedes' $(if ($isOther) { 'supersedes_not_approval' } else { 'supersedes_unknown' }) $(if ($isOther) { "record $s is not an approval" } else { "no stored record $s" })
    }
    if ($targetOk) {
        $t = $content['target']
        $resolved = $false
        if ($t['kind'] -ceq 'gate') { $resolved = $true }
        elseif ($null -ne $TargetResolver) { $resolved = [bool](& $TargetResolver $t) }
        if (-not $resolved) { & $addIssue 'target' 'unresolved_target' 'target does not resolve to an existing Claim revision, Run or defined Gate' }
        if ($supersedesOk) {
            [long]$s = $content['supersedes']
            if (-not $Analysis.Approvals.ContainsKey($s)) { & $supersedesProblem $s }
            elseif (-not (Test-SameTarget $Analysis.Approvals[$s]['target'] $t)) { & $addIssue 'supersedes' 'supersedes_target_differs' "record $s has a different target" }
            elseif ($Analysis.SupersededBy.ContainsKey($s)) { & $addIssue 'supersedes' 'supersedes_already_superseded' "record $s is already superseded" }
        }
    } elseif ($supersedesOk) {
        [long]$s = $content['supersedes']
        if (-not $Analysis.Approvals.ContainsKey($s)) { & $supersedesProblem $s }
    }
    if ($issues.Count -gt 0) {
        $seenKeys = [System.Collections.Generic.HashSet[string]]::new()
        $unique = @($issues | Where-Object { $seenKeys.Add("$($_.Field)`0$($_.Code)") })
        return , @($unique | Sort-Object -Property @{ Expression = { $_.Field }; Ascending = $true } -Stable)
    }
    , @()
}

# ---------------------------------------------------------------------------------------------------------------------
function Read-StoreBytes {
    param([string]$StorePath)
    if (-not (Test-Path -LiteralPath $StorePath -PathType Leaf)) { return , [byte[]]@() }
    $fs = [System.IO.File]::Open($StorePath, [System.IO.FileMode]::Open, [System.IO.FileAccess]::Read, [System.IO.FileShare]::ReadWrite)
    try {
        $ms = [System.IO.MemoryStream]::new()
        $fs.CopyTo($ms)
        , $ms.ToArray()
    } finally { $fs.Dispose() }
}

# Read-only verification of the store file (R23.9). Opens for reading only.
function Test-ApprovalStore {
    [CmdletBinding()]
    param([Parameter(Mandatory)][string]$StorePath, $Anchor)
    $bytes = Read-StoreBytes -StorePath $StorePath
    $a = Get-ApprovalStoreAnalysis -Bytes $bytes -Anchor $Anchor
    [pscustomobject]@{
        Ok = $a.Ok; LineCount = $a.LineCount; Mismatches = $a.Mismatches; RuleViolations = $a.RuleViolations
        TailTruncation = $a.TailTruncation; StaleTemp = (Test-Path -LiteralPath ($StorePath + '.tmp'))
        Note = 'No mismatch among the records present does not mean that the store is complete (tail removal is detected only with an external anchor), and recorded_by is a declaration.'
    }
}

# The read function for the Launcher gate check: verifies the chain, then returns the latest decision for a Gate (R6.9: the
# approval line with the highest seq for that target). An unknown Gate, an empty or missing store, or a store that does not
# verify means "no approval" (Status none). Writes nothing.
function Get-ApprovalGateStatus {
    [CmdletBinding()]
    param([Parameter(Mandatory)][string]$StorePath, [Parameter(Mandatory)][string]$GateId)
    $note = 'Backstop only: no mismatch among the records present; completeness (no external anchor) and the authenticity of recorded_by are not claimed.'
    $result = { param($status, $verified, $seq, $err) [pscustomobject]@{ GateId = $GateId; Status = $status; Verified = $verified; Seq = $seq; Error = $err; Note = $note } }
    if ($script:GateIds -cnotcontains $GateId) { return (& $result 'none' $true 0 'unknown_gate') }
    try { $bytes = Read-StoreBytes -StorePath $StorePath } catch { return (& $result 'none' $false 0 'unreadable') }
    $a = Get-ApprovalStoreAnalysis -Bytes $bytes
    if (-not $a.Ok) { return (& $result 'none' $false 0 'verification_failed') }
    $best = $null
    foreach ($l in $a.Approvals.Values) {
        if ($l['target']['kind'] -ceq 'gate' -and $l['target']['gate_id'] -ceq $GateId) { if ($null -eq $best -or [long]$l['seq'] -gt [long]$best['seq']) { $best = $l } }
    }
    if ($null -eq $best) { return (& $result 'none' $true 0 $null) }
    & $result ([string]$best['decision']) $true ([long]$best['seq']) $null
}

# ---------------------------------------------------------------------------------------------------------------------
function Write-StoreAtomically {
    param([string]$StorePath, [byte[]]$Content)
    $dir = Split-Path -Parent $StorePath
    if ($dir -and -not (Test-Path -LiteralPath $dir -PathType Container)) { [void][System.IO.Directory]::CreateDirectory($dir) }
    $tmp = $StorePath + '.tmp'
    try {
        $fs = [System.IO.FileStream]::new($tmp, [System.IO.FileMode]::Create, [System.IO.FileAccess]::Write, [System.IO.FileShare]::None)
        try { $fs.Write($Content, 0, $Content.Length); $fs.Flush($true) } finally { $fs.Dispose() }
        if (Test-Path -LiteralPath $StorePath -PathType Leaf) { [System.IO.File]::Replace($tmp, $StorePath, [NullString]::Value) }
        else { [System.IO.File]::Move($tmp, $StorePath) }
    } catch {
        try { if (Test-Path -LiteralPath $tmp -PathType Leaf) { [System.IO.File]::Delete($tmp) } } catch { }
        throw
    }
}

function New-RequestResult {
    param([string]$Outcome, [int]$ExitCode, $Issues = @(), $Line = $null, [string]$Message = '', $Report = $null)
    [pscustomobject]@{ Outcome = $Outcome; ExitCode = $ExitCode; Issues = @($Issues); Line = $Line; Message = $Message; Report = $Report }
}

# The only write path. $Request is a dictionary: operation (append | modify | delete | anything else), and for append the
# `candidate`, for modify and delete an optional `attempted_seq`.
function Invoke-ApprovalStoreRequest {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)][string]$StorePath,
        [Parameter(Mandatory)]$Request,
        [string]$MutexName = $script:StoreMutexName,
        [scriptblock]$TargetResolver,
        [int]$MutexWaitMs = 10000
    )
    $operation = $null
    if ($Request -is [System.Collections.IDictionary] -and $Request.Contains('operation')) { $operation = $Request['operation'] }
    if ($operation -isnot [string] -or @('append', 'modify', 'delete') -cnotcontains $operation) {
        return (New-RequestResult -Outcome 'invalid' -ExitCode 1 -Issues @([pscustomobject]@{ Field = 'operation'; Code = 'unknown_operation'; Message = 'not a request that the store understands' }) -Message 'unknown operation; the store is unchanged')
    }
    $mutex = [System.Threading.Mutex]::new($false, $MutexName)
    $held = $false
    try {
        try { $held = $mutex.WaitOne($MutexWaitMs) } catch [System.Threading.AbandonedMutexException] { $held = $true }
        if (-not $held) { return (New-RequestResult -Outcome 'mutex_timeout' -ExitCode 2 -Message 'the store mutex could not be taken; nothing was written') }

        try { $bytes = Read-StoreBytes -StorePath $StorePath } catch { return (New-RequestResult -Outcome 'write_failed' -ExitCode 2 -Message 'the store could not be read; nothing was written') }
        $analysis = Get-ApprovalStoreAnalysis -Bytes $bytes
        if (-not $analysis.Ok) {
            return (New-RequestResult -Outcome 'store_invalid' -ExitCode 2 -Report $analysis -Message 'the chain does not verify; it is reported and not extended')
        }

        $line = $null
        if ($operation -ceq 'append') {
            $issues = Test-ApprovalCandidate -Candidate $Request['candidate'] -Analysis $analysis -TargetResolver $TargetResolver
            if (@($issues).Count -gt 0) { return (New-RequestResult -Outcome 'invalid' -ExitCode 1 -Issues $issues -Message 'the record is not valid; the store is unchanged') }
            $line = [ordered]@{ type = 'approval'; seq = $analysis.NextSeq; prev_hash = $analysis.LastHash }
            foreach ($k in $Request['candidate'].Keys) { if ($null -ne $Request['candidate'][$k]) { $line[[string]$k] = $Request['candidate'][$k] } }
        } else {
            $line = [ordered]@{ type = 'store_rejection'; seq = $analysis.NextSeq; prev_hash = $analysis.LastHash; reason = $(if ($operation -ceq 'modify') { 'modify_refused' } else { 'delete_refused' }) }
            $attempted = if ($Request.Contains('attempted_seq')) { $Request['attempted_seq'] } else { $null }
            if ((Test-IsInteger $attempted) -and (@($analysis.Lines | Where-Object { [long]$_['seq'] -eq [long]$attempted }).Count -gt 0)) { $line['attempted_seq'] = [long]$attempted }
        }
        $line['hash'] = Get-StoredLineHash -Line $line
        $text = ConvertTo-StoredLineText -Line $line
        $newBytes = [byte[]]($bytes + $script:Utf8.GetBytes($text))
        try { Write-StoreAtomically -StorePath $StorePath -Content $newBytes }
        catch { return (New-RequestResult -Outcome 'write_failed' -ExitCode 2 -Message "the write failed and is not reported as stored: $($_.Exception.Message)") }
        if ($operation -ceq 'append') { return (New-RequestResult -Outcome 'stored' -ExitCode 0 -Line $line -Message "stored seq $($line['seq'])") }
        return (New-RequestResult -Outcome 'refused' -ExitCode 1 -Line $line -Message "$($line['reason']); a store_rejection line was appended (seq $($line['seq']))")
    } finally {
        if ($held) { try { $mutex.ReleaseMutex() } catch { } }
        $mutex.Dispose()
    }
}

Export-ModuleMember -Function Get-ApprovalGateIds, Get-ApprovalStoreAnalysis, Test-ApprovalCandidate, Test-ApprovalStore, Get-ApprovalGateStatus, Invoke-ApprovalStoreRequest, Get-StoredLineHash, ConvertTo-StoredLineText