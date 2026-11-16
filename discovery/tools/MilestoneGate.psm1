#Requires -Version 7.0
# The M3 start gate under R21.20 (the one-time exception for the M0 checkpoint, 2026-11-14). Read-only: it never writes the
# Approval_Store or any other file. It allows the start of M3 only when ALL of the following hold, and refuses otherwise:
#   1. the M2 checkpoint 2.24 is checked in tasks.md (R21.3 met);
#   2. the Approval_Store verifies (a tampered store refuses: store_invalid);
#   3. the latest record for the Gate `m0-checkpoint-exception` has the decision `approved` (none: not_approved; rejected;
#      needs_changes; a later superseding record counts);
#   4. that record is declared `recorded_by: human` (a declaration, not an authenticated identity);
#   5. its rationale names R21.20 and the SHA-256 of requirements.md, design.md, and tasks.md as `<file>=<64 hex>`, exactly once
#      each, and each equals the current file (hashes_missing, hash_mismatch).
# An approval of any other Gate, `start-implementation` included, never satisfies this gate, and this gate never stands for the
# start instruction of R21.19 or for meeting the M0 acceptance condition. The exception covers the start of M3 only; the start of
# M4 is covered only by the separate exception of R21.21 (Test-M4StartGate below), and every other transition follows R21.9 unchanged. The check is made at the start of M3: any later edit of a spec file changes its hash, so a
# repeated check after the start is expected to report hash_mismatch.
Set-StrictMode -Version Latest
Import-Module (Join-Path $PSScriptRoot 'DiscoveryCommon.psm1') -DisableNameChecking
Import-Module (Join-Path $PSScriptRoot 'ApprovalStore.psm1') -DisableNameChecking

$script:ExceptionGate = 'm0-checkpoint-exception'
$script:SpecFiles = @('requirements.md', 'design.md', 'tasks.md')

function Get-SpecHashes {
    param([Parameter(Mandatory)][string]$SpecDir)
    $h = [ordered]@{}; foreach ($f in $script:SpecFiles) { $h[$f] = Get-Sha256HexOfFile -Path (Join-Path $SpecDir $f) }; $h
}

function Test-M3StartGate {
    [CmdletBinding()]
    param([Parameter(Mandatory)][string]$RepoRoot, [string]$StorePath)
    if (-not $StorePath) { $StorePath = Join-Path $RepoRoot 'discovery/approvals/approvals.jsonl' }
    $specDir = Join-Path $RepoRoot '.kiro/specs/discovery-loop'
    $out = { param($ok, $code, $detail, $seq = 0) [pscustomobject]@{ Ok = $ok; Code = $code; Detail = $detail; Seq = $seq; Gate = $script:ExceptionGate } }
    foreach ($f in $script:SpecFiles) { if (-not (Test-Path -LiteralPath (Join-Path $specDir $f) -PathType Leaf)) { return (& $out $false 'spec_missing' $f) } }
    $tasks = [System.IO.File]::ReadAllText((Join-Path $specDir 'tasks.md'))
    if ($tasks -cnotmatch '(?m)^\s*- \[x\] 2\.24 Checkpoint - M2 acceptance') { return (& $out $false 'm2_not_accepted' 'task 2.24 is not checked') }
    if (-not (Test-Path -LiteralPath $StorePath -PathType Leaf)) { return (& $out $false 'not_approved' 'no Approval_Store') }
    $v = Test-ApprovalStore -StorePath $StorePath
    if (-not $v.Ok) { return (& $out $false 'store_invalid' 'the Approval_Store does not verify') }
    $g = Get-ApprovalGateStatus -StorePath $StorePath -GateId $script:ExceptionGate
    if ($g.Status -ne 'approved') {
        $code = switch ($g.Status) { 'rejected' { 'rejected' } 'needs_changes' { 'needs_changes' } default { 'not_approved' } }
        return (& $out $false $code "latest decision: $($g.Status)" $g.Seq)
    }
    $a = Get-ApprovalStoreAnalysis -Bytes ([System.IO.File]::ReadAllBytes($StorePath))
    $rec = $null; foreach ($l in $a.Approvals.Values) { if ([long]$l['seq'] -eq [long]$g.Seq) { $rec = $l } }
    if ($null -eq $rec) { return (& $out $false 'store_invalid' 'the approved record was not found' $g.Seq) }
    if ([string]$rec['recorded_by'] -cne 'human') { return (& $out $false 'not_human' 'the record is not declared recorded_by human' $g.Seq) }
    $rat = [string]$rec['rationale']
    if (-not $rat.Contains('R21.20')) { return (& $out $false 'hashes_missing' 'the rationale does not name R21.20' $g.Seq) }
    $now = Get-SpecHashes -SpecDir $specDir
    $missing = [System.Collections.Generic.List[string]]::new(); $differ = [System.Collections.Generic.List[string]]::new()
    foreach ($f in $script:SpecFiles) {
        $ms = [regex]::Matches($rat, '(?<![A-Za-z0-9_.-])' + [regex]::Escape($f) + '=([0-9a-f]{64})(?![0-9a-f])')
        if ($ms.Count -ne 1) { $missing.Add($f); continue }
        if ($ms[0].Groups[1].Value -cne $now[$f]) { $differ.Add($f) }
    }
    if ($missing.Count -gt 0) { return (& $out $false 'hashes_missing' ($missing -join ',') $g.Seq) }
    if ($differ.Count -gt 0) { return (& $out $false 'hash_mismatch' ($differ -join ',') $g.Seq) }
    & $out $true 'allowed' 'M3 start allowed under R21.20 only; the M0 checkpoint 0.14 stays open; the start of M4 is not covered (R21.9 applies unchanged, or R21.21 with its own record)' $g.Seq
}

# ---------------------------------------------------------------------------------------------------------------------
# The M4 start gate under R21.21 (the one-time exception for the M0 checkpoint, for the start of M4 only; 2026-11-15).
# Read-only: it never writes the Approval_Store or any file; its only external call is the read-only `git merge-base --is-ancestor`.
# It is forward-looking. It never stands for the start instruction of R21.19, never meets the M0 acceptance condition, never closes
# the tasks 0.13 and 0.14, and approves no earlier operation. It allows the start of M4 only when ALL of the following hold:
#   0. the requested milestone is M4 (any other value: exception_not_applicable, checked first; the exception is never carried over);
#   1. the three spec files exist (spec_missing);
#   2. the M3 checkpoint 3.12 is checked in tasks.md (m3_not_accepted);
#   3. the M3 commit named in R21.21 is an ancestor of the checked-out commit (m3_commit_not_ancestor);
#   4. the Approval_Store exists and verifies (not_approved, store_invalid);
#   5. the latest record for the Gate `m4-start-exception` has the decision `approved` (not_approved, rejected, needs_changes; a later
#      superseding record counts), and is declared `recorded_by: human` (not_human; a declaration, not an authenticated identity);
#   6. its rationale names R21.21, names `m3-commit=<the commit of R21.21>` exactly once, and names the SHA-256 of requirements.md,
#      design.md, and tasks.md as `<file>=<64 hex>` exactly once each, each equal to the current file (hashes_missing, commit_missing,
#      commit_mismatch, hash_mismatch);
#   7. the latest record for the Gate `override-apply` has the decision `approved` and is declared `recorded_by: human`
#      (override_not_approved), its rationale names exactly one SHA-256 value (override_hash_missing), the Discovery_Override file
#      exists (override_missing), and the file has that SHA-256 (override_hash_mismatch).
# An approval of any other Gate, `m0-checkpoint-exception` and `start-implementation` included, never satisfies this gate.
# The check is made at the start of M4: any later edit of a spec file changes its hash, so a repeated check after the start is
# expected to report hash_mismatch.
$script:M4ExceptionGate = 'm4-start-exception'
$script:OverrideGate = 'override-apply'
$script:M3Commit = '0d695ed567ca9c02e59def2e3b28bbe9af7d3772'
$script:OverrideRelativePath = 'infra/docker-compose.discovery.yml'

function Get-LatestApprovedGateRecord {
    param([Parameter(Mandatory)][string]$StorePath, [Parameter(Mandatory)][string]$GateId)
    $g = Get-ApprovalGateStatus -StorePath $StorePath -GateId $GateId
    $rec = $null
    if ($g.Status -eq 'approved') {
        $a = Get-ApprovalStoreAnalysis -Bytes ([System.IO.File]::ReadAllBytes($StorePath))
        foreach ($l in $a.Approvals.Values) { if ([long]$l['seq'] -eq [long]$g.Seq) { $rec = $l } }
    }
    [pscustomobject]@{ Status = $g.Status; Seq = $g.Seq; Record = $rec }
}

function Test-CommitIsAncestorOfHead {
    param([Parameter(Mandatory)][string]$RepoRoot, [Parameter(Mandatory)][string]$Commit)
    try {
        $null = & git -C $RepoRoot merge-base --is-ancestor $Commit HEAD 2>$null
        return ($LASTEXITCODE -eq 0)
    } catch { return $false }
}

function Test-M4StartGate {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)][string]$RepoRoot,
        [string]$StorePath,
        [string]$TargetMilestone = 'M4',
        [scriptblock]$IsAncestor
    )
    if (-not $StorePath) { $StorePath = Join-Path $RepoRoot 'discovery/approvals/approvals.jsonl' }
    $specDir = Join-Path $RepoRoot '.kiro/specs/discovery-loop'
    $out = { param($ok, $code, $detail, $seq = 0) [pscustomobject]@{ Ok = $ok; Code = $code; Detail = $detail; Seq = $seq; Gate = $script:M4ExceptionGate } }
    if ($TargetMilestone -cne 'M4') { return (& $out $false 'exception_not_applicable' "the exception of R21.21 covers the start of M4 only; requested: $TargetMilestone") }
    foreach ($f in $script:SpecFiles) { if (-not (Test-Path -LiteralPath (Join-Path $specDir $f) -PathType Leaf)) { return (& $out $false 'spec_missing' $f) } }
    $tasks = [System.IO.File]::ReadAllText((Join-Path $specDir 'tasks.md'))
    if ($tasks -cnotmatch '(?m)^\s*- \[x\] 3\.12 Checkpoint - M3 acceptance') { return (& $out $false 'm3_not_accepted' 'task 3.12 is not checked') }
    $isAnc = if ($null -ne $IsAncestor) { [bool](& $IsAncestor $RepoRoot $script:M3Commit) } else { Test-CommitIsAncestorOfHead -RepoRoot $RepoRoot -Commit $script:M3Commit }
    if (-not $isAnc) { return (& $out $false 'm3_commit_not_ancestor' "the M3 commit $($script:M3Commit) is not an ancestor of the checked-out commit") }
    if (-not (Test-Path -LiteralPath $StorePath -PathType Leaf)) { return (& $out $false 'not_approved' 'no Approval_Store') }
    $v = Test-ApprovalStore -StorePath $StorePath
    if (-not $v.Ok) { return (& $out $false 'store_invalid' 'the Approval_Store does not verify') }

    $x = Get-LatestApprovedGateRecord -StorePath $StorePath -GateId $script:M4ExceptionGate
    if ($x.Status -ne 'approved' -or $null -eq $x.Record) {
        $code = switch ($x.Status) { 'rejected' { 'rejected' } 'needs_changes' { 'needs_changes' } default { 'not_approved' } }
        return (& $out $false $code "latest decision: $($x.Status)" $x.Seq)
    }
    if ([string]$x.Record['recorded_by'] -cne 'human') { return (& $out $false 'not_human' 'the record is not declared recorded_by human' $x.Seq) }
    $rat = [string]$x.Record['rationale']
    if (-not $rat.Contains('R21.21')) { return (& $out $false 'hashes_missing' 'the rationale does not name R21.21' $x.Seq) }
    $cm = [regex]::Matches($rat, '(?<![A-Za-z0-9_.-])m3-commit=([0-9a-f]{40})(?![0-9a-f])')
    if ($cm.Count -ne 1) { return (& $out $false 'commit_missing' 'the rationale does not name m3-commit=<40 hex> exactly once' $x.Seq) }
    if ($cm[0].Groups[1].Value -cne $script:M3Commit) { return (& $out $false 'commit_mismatch' 'the commit in the rationale is not the M3 commit of R21.21' $x.Seq) }
    $now = Get-SpecHashes -SpecDir $specDir
    $missing = [System.Collections.Generic.List[string]]::new(); $differ = [System.Collections.Generic.List[string]]::new()
    foreach ($f in $script:SpecFiles) {
        $ms = [regex]::Matches($rat, '(?<![A-Za-z0-9_.-])' + [regex]::Escape($f) + '=([0-9a-f]{64})(?![0-9a-f])')
        if ($ms.Count -ne 1) { $missing.Add($f); continue }
        if ($ms[0].Groups[1].Value -cne $now[$f]) { $differ.Add($f) }
    }
    if ($missing.Count -gt 0) { return (& $out $false 'hashes_missing' ($missing -join ',') $x.Seq) }
    if ($differ.Count -gt 0) { return (& $out $false 'hash_mismatch' ($differ -join ',') $x.Seq) }

    $o = Get-LatestApprovedGateRecord -StorePath $StorePath -GateId $script:OverrideGate
    if ($o.Status -ne 'approved' -or $null -eq $o.Record) { return (& $out $false 'override_not_approved' "latest override-apply decision: $($o.Status)" $o.Seq) }
    if ([string]$o.Record['recorded_by'] -cne 'human') { return (& $out $false 'override_not_approved' 'the override-apply record is not declared recorded_by human' $o.Seq) }
    $hs = @([regex]::Matches([string]$o.Record['rationale'], '(?<![0-9A-Za-z])[0-9a-f]{64}(?![0-9A-Za-z])') | ForEach-Object { $_.Value } | Sort-Object -Unique)
    if ($hs.Count -ne 1) { return (& $out $false 'override_hash_missing' "the override-apply rationale names $($hs.Count) distinct SHA-256 values; exactly one is required" $o.Seq) }
    $ovPath = Join-Path $RepoRoot $script:OverrideRelativePath
    if (-not (Test-Path -LiteralPath $ovPath -PathType Leaf)) { return (& $out $false 'override_missing' $script:OverrideRelativePath $o.Seq) }
    if ((Get-Sha256HexOfFile -Path $ovPath) -cne $hs[0]) { return (& $out $false 'override_hash_mismatch' 'the Discovery_Override file differs from the approved hash' $o.Seq) }
    & $out $true 'allowed' 'M4 start allowed under R21.21 only; the M0 checkpoint 0.14 and the task 0.13 stay open; no M4 acceptance condition is relaxed; M5 and later follow R21.9' $x.Seq
}
Export-ModuleMember -Function Get-SpecHashes, Test-M3StartGate, Test-M4StartGate