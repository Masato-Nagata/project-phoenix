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
# M4 and later follows R21.9 unchanged. The check is made at the start of M3: any later edit of a spec file changes its hash, so a
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
    & $out $true 'allowed' 'M3 start allowed under R21.20 only; the M0 checkpoint 0.14 stays open; R21.9 applies unchanged from the start of M4' $g.Seq
}

Export-ModuleMember -Function Get-SpecHashes, Test-M3StartGate