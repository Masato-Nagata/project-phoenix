#Requires -Version 7.0
<#
.SYNOPSIS
  The human-facing command that appends one Approval_Record to the Approval_Store (task 2.25, design "Host-side command").
.DESCRIPTION
  Builds an `append` request and sends it to Invoke-ApprovalStoreRequest of ApprovalStore.psm1, the only code that writes the store.
  There is no parameter for a timestamp (the host clock is used, R23.5), none for modify or delete, and no default or environment
  fallback for any value. Every missing or invalid field is named on stderr; the store is byte-identical after a failure.
  Target kinds of part 1 (task 2.25): gate:<gate-id> only. run: and claim: targets are rejected as unresolvable until task 4.10.
  The command never writes a record on its own initiative (R23.8): the values come from the human.
  -Verify opens the store read-only and reports every mismatch. Exit status 0 means "no mismatch among the records present".
.EXAMPLE
  Add-ApprovalRecord.ps1 -Approver 'Name' -Decision approved -Target gate:override-apply -Rationale 'text' -Actor human
#>
[CmdletBinding(DefaultParameterSetName = 'Record')]
param(
    [Parameter(ParameterSetName = 'Record')][string]$Approver,
    [Parameter(ParameterSetName = 'Record')][string]$Decision,
    [Parameter(ParameterSetName = 'Record')][string]$Target,
    [Parameter(ParameterSetName = 'Record')][string]$Rationale,
    [Parameter(ParameterSetName = 'Record')][string]$Actor,
    [Parameter(ParameterSetName = 'Record')][string]$Supersedes,
    [Parameter(ParameterSetName = 'Verify', Mandatory)][switch]$Verify,
    [string]$StorePath
)
$ErrorActionPreference = 'Stop'
Import-Module (Join-Path $PSScriptRoot 'ApprovalStore.psm1') -Force -DisableNameChecking
if (-not $StorePath) { $StorePath = Join-Path (Join-Path $PSScriptRoot '../approvals') 'approvals.jsonl' }

if ($PSCmdlet.ParameterSetName -eq 'Verify') {
    $r = Test-ApprovalStore -StorePath $StorePath
    foreach ($m in $r.Mismatches) { [Console]::Error.WriteLine("mismatch: seq $($m.Seq) kind $($m.Kind): $($m.Detail)") }
    foreach ($v in $r.RuleViolations) { [Console]::Error.WriteLine("rule violation: seq $($v.Seq) $($v.Rule): $($v.Detail)") }
    if ($r.StaleTemp) { [Console]::Error.WriteLine('warning: a stale approvals.jsonl.tmp exists') }
    Write-Output "lines: $($r.LineCount); tail truncation: $($r.TailTruncation)"
    Write-Output $r.Note
    if ($r.Ok) { exit 0 } else { exit 1 }
}

$candidate = [ordered]@{}
if ($PSBoundParameters.ContainsKey('Approver')) { $candidate['approver'] = $Approver }
if ($PSBoundParameters.ContainsKey('Decision')) { $candidate['decision'] = $Decision }
if ($PSBoundParameters.ContainsKey('Rationale')) { $candidate['rationale'] = $Rationale }
if ($PSBoundParameters.ContainsKey('Actor')) { $candidate['recorded_by'] = $Actor }
if ($PSBoundParameters.ContainsKey('Target')) {
    $t = $Target
    if ($t -cmatch '^gate:(.+)$') { $candidate['target'] = [ordered]@{ kind = 'gate'; gate_id = $Matches[1] } }
    elseif ($t -cmatch '^run:(.+)$') { $candidate['target'] = [ordered]@{ kind = 'run'; run_id = $Matches[1] } }
    elseif ($t -cmatch '^claim:([^/]+)/(.+)$') { $candidate['target'] = [ordered]@{ kind = 'claim_revision'; run_id = $Matches[1]; claim_revision_id = $Matches[2] } }
    else { $candidate['target'] = $t }   # not a target: the store layer names the field
}
if ($PSBoundParameters.ContainsKey('Supersedes')) {
    $n = 0L
    $candidate['supersedes'] = $(if ([long]::TryParse($Supersedes, [ref]$n)) { $n } else { $Supersedes })
}
# The host clock, ISO 8601 with offset (R23.5). There is no parameter that can replace it.
$candidate['timestamp'] = [DateTimeOffset]::Now.ToString("yyyy-MM-dd'T'HH:mm:ss.fffzzz", [System.Globalization.CultureInfo]::InvariantCulture)

$result = Invoke-ApprovalStoreRequest -StorePath $StorePath -Request ([ordered]@{ operation = 'append'; candidate = $candidate })
switch ($result.Outcome) {
    'stored' { Write-Output $result.Message; exit 0 }
    'invalid' {
        foreach ($i in $result.Issues) { [Console]::Error.WriteLine("invalid field: $($i.Field) ($($i.Code))") }
        [Console]::Error.WriteLine($result.Message)
        exit 1
    }
    default {
        [Console]::Error.WriteLine("$($result.Outcome): $($result.Message)")
        if ($null -ne $result.Report) {
            foreach ($m in $result.Report.Mismatches) { [Console]::Error.WriteLine("mismatch: seq $($m.Seq) kind $($m.Kind)") }
        }
        exit $result.ExitCode
    }
}