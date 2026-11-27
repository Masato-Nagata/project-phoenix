#Requires -Version 7.0
<#
.SYNOPSIS
  The human-facing command that appends one Approval_Record to the Approval_Store (task 2.25, design "Host-side command").
.DESCRIPTION
  Builds an `append` request and sends it to Invoke-ApprovalStoreRequest of ApprovalStore.psm1, the only code that writes the store.
  There is no parameter for a timestamp (the host clock is used, R23.5), none for modify or delete, and no default or environment
  fallback for any value. Every missing or invalid field is named on stderr; the store is byte-identical after a failure.
  Target kinds: gate:<gate-id>, run:<run-id>, and claim:<run-id>/<claim-revision-id>. A run: or claim: target is resolved by
  ApprovalTargetResolver.psm1 in the fixed runs directory of the repository (there is no parameter for another one): a strict Run id,
  one bounded verification of the Run before the store is opened, and a second independent bounded verification under the store mutex,
  after the store was verified and before the final store comparison and the atomic write. The manifest hash of the first verification
  must be the same in the second. A gate: target does not use the Run check.
  -ExpectManifestSha256 (optional; run: and claim: targets only; 64 lower-case hex characters) must equal the manifest hash in both
  verifications. The hash is not written into the record.
  The command never writes a record on its own initiative (R23.8): the values come from the human.
  -Verify opens the store read-only and reports every mismatch. Exit status 0 means "no mismatch among the records present".
  -AnchorPath (optional, for an append and for -Verify) names an external anchor file that a human keeps outside the repository: an absolute
  path, JSON {"seq":N,"hash":"<64 lower-case hex>"}. The chain is then checked up to the anchored record; records after it are checked for
  internal consistency only. An anchor that is missing, unreadable, malformed or in the repository is refused with a fixed code and the store is
  not changed; there is no fallback to "no anchor". This command never creates or changes an anchor.
.EXAMPLE
  Add-ApprovalRecord.ps1 -Approver 'Name' -Decision approved -Target gate:override-apply -Rationale 'text' -Actor human
.EXAMPLE
  Add-ApprovalRecord.ps1 -Verify -AnchorPath 'D:\keep\phoenix-approval-anchor.json'
#>
[CmdletBinding(DefaultParameterSetName = 'Record')]
param(
    [Parameter(ParameterSetName = 'Record')][string]$Approver,
    [Parameter(ParameterSetName = 'Record')][string]$Decision,
    [Parameter(ParameterSetName = 'Record')][string]$Target,
    [Parameter(ParameterSetName = 'Record')][string]$Rationale,
    [Parameter(ParameterSetName = 'Record')][string]$Actor,
    [Parameter(ParameterSetName = 'Record')][string]$Supersedes,
    [Parameter(ParameterSetName = 'Record')][string]$ExpectManifestSha256,
    [Parameter(ParameterSetName = 'Verify', Mandatory)][switch]$Verify,
    [string]$StorePath,
    [string]$AnchorPath
)
$ErrorActionPreference = 'Stop'
Import-Module (Join-Path $PSScriptRoot 'ApprovalStore.psm1') -Force -DisableNameChecking
Import-Module (Join-Path $PSScriptRoot 'ApprovalTargetResolver.psm1') -Force -DisableNameChecking
if (-not $StorePath) { $StorePath = Join-Path (Join-Path $PSScriptRoot '../approvals') 'approvals.jsonl' }

# An anchor path that is given is always used: an empty or invalid value is refused by the store layer, never ignored.
$anchorArgs = @{}
if ($PSBoundParameters.ContainsKey('AnchorPath')) { $anchorArgs['AnchorPath'] = $AnchorPath }

if ($PSCmdlet.ParameterSetName -eq 'Verify') {
    $r = Test-ApprovalStore -StorePath $StorePath @anchorArgs
    if ($r.AnchorStatus -eq 'rejected') {
        [Console]::Error.WriteLine("anchor_rejected: $($r.AnchorCode)")
        Write-Output $r.Note
        exit 2
    }
    foreach ($m in $r.Mismatches) { [Console]::Error.WriteLine("mismatch: seq $($m.Seq) kind $($m.Kind): $($m.Detail)") }
    foreach ($v in $r.RuleViolations) { [Console]::Error.WriteLine("rule violation: seq $($v.Seq) $($v.Rule): $($v.Detail)") }
    if ($r.StaleTemp) { [Console]::Error.WriteLine('warning: a stale approvals.jsonl.tmp exists') }
    Write-Output "lines: $($r.LineCount); tail truncation: $($r.TailTruncation)"
    if ($r.AnchorStatus -eq 'applied' -and $null -ne $r.RecordsAfterAnchor) { Write-Output "anchor: seq $($r.AnchorSeq) compared; records after the anchor (internal consistency only): $($r.RecordsAfterAnchor)" }
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
    # run: and claim: are matched against the whole text (\A...\z): a trailing line feed is not dropped silently as `$` would do.
    elseif ($t -cmatch '\Arun:(.+)\z') { $candidate['target'] = [ordered]@{ kind = 'run'; run_id = $Matches[1] } }
    elseif ($t -cmatch '\Aclaim:([^/]+)/(.+)\z') { $candidate['target'] = [ordered]@{ kind = 'claim_revision'; run_id = $Matches[1]; claim_revision_id = $Matches[2] } }
    else { $candidate['target'] = $t }   # not a target: the store layer names the field
}
if ($PSBoundParameters.ContainsKey('Supersedes')) {
    $n = 0L
    $candidate['supersedes'] = $(if ([long]::TryParse($Supersedes, [ref]$n)) { $n } else { $Supersedes })
}
# The host clock, ISO 8601 with offset (R23.5). There is no parameter that can replace it.
$candidate['timestamp'] = [DateTimeOffset]::Now.ToString("yyyy-MM-dd'T'HH:mm:ss.fffzzz", [System.Globalization.CultureInfo]::InvariantCulture)

# run: and claim: targets (step B3b). The Run is verified here once (first verification, before the store is opened) and again by the
# resolver under the store mutex. A gate: target takes neither path and is handled exactly as before.
$targetKind = $null
if ($candidate.Contains('target') -and $candidate['target'] -is [System.Collections.IDictionary]) { $targetKind = [string]$candidate['target']['kind'] }
$isRunTarget = ($targetKind -ceq 'run') -or ($targetKind -ceq 'claim_revision')
if ($PSBoundParameters.ContainsKey('ExpectManifestSha256')) {
    $expectIssue = $null
    if (-not $isRunTarget) { $expectIssue = 'undefined_field' }
    elseif ($ExpectManifestSha256 -cnotmatch '\A[0-9a-f]{64}\z') { $expectIssue = 'bad_value' }
    if ($expectIssue) {
        [Console]::Error.WriteLine("invalid field: ExpectManifestSha256 ($expectIssue)")
        [Console]::Error.WriteLine('the record is not valid; the store is unchanged')
        exit 1
    }
}
$resolverArgs = @{}
$targetControl = $null
if ($isRunTarget) {
    $runsRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../runs'))
    $controlArgs = @{}
    if ($PSBoundParameters.ContainsKey('ExpectManifestSha256')) { $controlArgs['ExpectManifestSha256'] = $ExpectManifestSha256 }
    $targetControl = New-ApprovalTargetControl -Target $candidate['target'] -RunsRoot $runsRoot @controlArgs
    $resolverArgs['TargetResolver'] = $targetControl.Resolver
}

$result = Invoke-ApprovalStoreRequest -StorePath $StorePath -Request ([ordered]@{ operation = 'append'; candidate = $candidate }) @anchorArgs @resolverArgs
switch ($result.Outcome) {
    'stored' { Write-Output $result.Message; exit 0 }
    'invalid' {
        foreach ($i in $result.Issues) { [Console]::Error.WriteLine("invalid field: $($i.Field) ($($i.Code))") }
        # A fixed code of the Run check; never a path, hash, record content, or exception text.
        if ($null -ne $targetControl -and $targetControl.State.LastCode -and @($result.Issues | Where-Object { $_.Field -ceq 'target' }).Count -gt 0) {
            [Console]::Error.WriteLine("target_check: $($targetControl.State.LastCode)")
        }
        [Console]::Error.WriteLine($result.Message)
        exit 1
    }
    default {
        [Console]::Error.WriteLine("$($result.Outcome): $($result.Message)")
        if ($result.Reason) { [Console]::Error.WriteLine("reason: $($result.Reason)") }
        if ($null -ne $result.Report) {
            foreach ($m in $result.Report.Mismatches) { [Console]::Error.WriteLine("mismatch: seq $($m.Seq) kind $($m.Kind)") }
        }
        exit $result.ExitCode
    }
}