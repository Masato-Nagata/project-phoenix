#Requires -Version 7.0
# Pure reader and classifier of the ONE line that the runtime entry point (packages/discovery-loop/src/main.ts) writes to standard error
# (task 4.9-C1). It touches no file, no process, and no Docker. Since task 4.9-C2 the Launcher (Get-RuntimeExitReport) passes it the captured line.
#
# The input is the BYTES of the captured stream (the caller bounds the capture to 8 KiB) and the exit code of the runtime container.
# Nothing the runtime wrote is trusted: the line is accepted only when ALL of these hold, otherwise the result carries a closed reason
# code and never the text:
#   - at most 8192 bytes, valid UTF-8, no BOM, exactly one line that ends with ONE LF (no CR, no NUL, no other LF);
#   - strict JSON (a duplicate key is refused), one object, no number anywhere;
#   - `phase` is one of the closed phases, and the key set is exactly the closed key set of that phase (plus the optional `timers`);
#   - every string value is an exact member of the closed vocabulary of its field.
# The vocabulary is a copy of the TypeScript lists; tests compare the SETS with main.ts and config/startup.ts. A value that is not in
# the list is REFUSED, never mapped to `unlisted`. The literal `unlisted` is accepted only in the fields where main.ts passes the value
# through `closed(...)` (it is the runtime's own marker for a value that is not in its list); it is never a normal termination.
#
# The exit code is the runtime's, not the Launcher's: 0 = the Run_Manifest is sealed, 1 = not sealed, 2 = refused before the Run. Exit 0
# does NOT say the purpose of the Run was met. This module classifies; it does not decide `complete` (the export must also succeed), and
# a parsed line is NOT an independent verification of the seal or of the evidence.
Set-StrictMode -Version Latest
Import-Module (Join-Path $PSScriptRoot 'DiscoveryCommon.psm1') -DisableNameChecking

$script:MaxReportBytes = 8192
$script:Utf8Strict = [System.Text.UTF8Encoding]::new($false, $true)
$script:Phases = @('input', 'stage_a', 'stage_b', 'assembly', 'compose', 'run', 'internal')
$script:InputCodes = @('run_config_missing', 'run_config_unreadable', 'run_config_invalid')
$script:AssemblyCodes = @('isolation_unavailable', 'facts_reader_invalid', 'repo_root_invalid', 'allowlist_unreadable', 'allowlist_invalid', 'template_unreadable',
    'audit_adapter_invalid', 'provider_not_mock', 'provider_unavailable', 'response_limits_invalid')
$script:ConfigIssueCodes = @('required_missing', 'unknown_key', 'null_value', 'wrong_type', 'not_integer', 'out_of_range', 'enum_mismatch', 'cross_field', 'above_fixed_bound', 'pattern_mismatch')
$script:ComposeCodes = @('input_invalid', 'startup_invalid', 'nonce_invalid', 'deps_invalid', 'lease_facts_refused', 'launcher_facts_refused', 'runtime_versions_refused',
    'start_state_cell_refused', 'manifest_port_refused')
$script:TerminationReasons = @('iteration_limit_reached', 'experiment_limit_reached', 'time_limit_reached', 'no_further_experiments', 'provider_failure', 'payload_audit_blocked',
    'policy_rejection_limit', 'isolation_violation', 'lease_unavailable', 'launcher_killed', 'error')
$script:NormalTerminationReasons = @('iteration_limit_reached', 'experiment_limit_reached', 'time_limit_reached', 'no_further_experiments')
$script:UnsealedFailures = @('runner_start_refused', 'store_open_failed', 'lease_invalid_at_start', 'store_failed', 'secret_rejected', 'manifest_build_failed', 'seal_failed', 'internal_error')
$script:TimerNotes = @('timers_left', 'timers_not_cleared')
$script:StartupChecks = @('config', 'policy', 'auditConfig', 'env', 'sandbox', 'lease', 'io')
$script:StartupRefusalCodes = @('config_not_validated', 'policy_unavailable', 'policy_invalid', 'preparation_table_invalid', 'above_policy_limit', 'audit_config_missing',
    'audit_config_empty', 'audit_config_unreadable', 'audit_config_invalid', 'credential_unset', 'provider_unknown', 'provider_not_available',
    'sandbox_destinations_undetermined', 'lease_env_missing', 'lease_timing_invalid', 'lease_invalid', 'lease_check_failed', 'run_volume_missing',
    'run_volume_not_writable', 'run_volume_not_empty', 'config_files_unexpected', 'io_unreadable', 'port_failed')
$script:UnlistedMarker = 'unlisted'

function Get-RuntimeReportVocabulary {
    [ordered]@{
        Phases = @($script:Phases); InputCodes = @($script:InputCodes); AssemblyCodes = @($script:AssemblyCodes); ConfigIssueCodes = @($script:ConfigIssueCodes)
        ComposeCodes = @($script:ComposeCodes); TerminationReasons = @($script:TerminationReasons); NormalTerminationReasons = @($script:NormalTerminationReasons)
        UnsealedFailures = @($script:UnsealedFailures); TimerNotes = @($script:TimerNotes); StartupChecks = @($script:StartupChecks)
        StartupRefusalCodes = @($script:StartupRefusalCodes); UnlistedMarker = $script:UnlistedMarker; MaxReportBytes = $script:MaxReportBytes
    }
}

# 'normal' for the four limit or exhaustion reasons, 'abnormal' for every other listed reason AND for the runtime's own `unlisted`,
# and $null for anything else. `normal` does not mean that the purpose of the Run was met.
function Get-RuntimeTerminationClass {
    param([AllowNull()]$Reason)
    if ($Reason -isnot [string]) { return $null }
    if ($script:NormalTerminationReasons -ccontains $Reason) { return 'normal' }
    if ($script:TerminationReasons -ccontains $Reason -or $Reason -ceq $script:UnlistedMarker) { return 'abnormal' }
    $null
}

# The three failure kinds of a value: not the right type, or not in the vocabulary.
function Test-ReportString {
    param($Value, [string[]]$List, [bool]$AllowUnlisted)
    if ($Value -isnot [string]) { return 'report_type_invalid' }
    if ($List -ccontains $Value) { return $null }
    if ($AllowUnlisted -and $Value -ceq $script:UnlistedMarker) { return $null }
    'report_value_invalid'
}

function Test-ReportStringArray {
    param($Value, [string[]]$List, [int]$Max)
    if ($Value -isnot [System.Collections.IList]) { return 'report_type_invalid' }
    $items = @($Value)
    if ($items.Count -lt 1 -or $items.Count -gt $Max) { return 'report_value_invalid' }
    $seen = [System.Collections.Generic.HashSet[string]]::new([StringComparer]::Ordinal)
    foreach ($i in $items) {
        $c = Test-ReportString -Value $i -List $List -AllowUnlisted $true
        if ($null -ne $c) { return $c }
        if (-not $seen.Add([string]$i)) { return 'report_value_invalid' }
    }
    $null
}

function Get-ReportKeys { param($Dict) , @($Dict.Keys | ForEach-Object { [string]$_ }) }

# $null when the key set is exactly required (all present) plus a subset of optional.
function Test-ReportKeySet {
    param([string[]]$Keys, [string[]]$Required, [string[]]$Optional)
    foreach ($r in $Required) { if ($Keys -cnotcontains $r) { return 'report_keys_invalid' } }
    foreach ($k in $Keys) { if ($Required -cnotcontains $k -and $Optional -cnotcontains $k) { return 'report_keys_invalid' } }
    $null
}

function ConvertFrom-RuntimeReport {
    [CmdletBinding()]
    param([AllowNull()][byte[]]$Bytes, [Parameter(Mandatory)][int]$ExitCode)
    $r = [ordered]@{
        Status = 'invalid'; ReportCode = $null; ExitCode = $ExitCode; Consistency = 'not_applicable'; Phase = $null; Sealed = $null; Started = $null
        TerminationReason = $null; TerminationClass = $null; Failure = $null; Code = $null; Codes = @(); Refusals = @(); Timers = @()
        Classification = $null; CompleteEligible = $false; LauncherExitCode = 1; PurposeAssessment = 'not_assessed'
    }
    # Every refusal returns through $finish. A refused line gives back NOTHING that came from it: the fields that a partial parse may have
    # filled are reset to their defaults here. Kept: Status, the closed ReportCode, the runtime exit code (from Docker, not from the line),
    # Consistency (not_applicable), Classification, CompleteEligible ($false), LauncherExitCode (1), PurposeAssessment.
    $finish = {
        param($status, $code)
        $r['Status'] = $status; $r['ReportCode'] = $code
        if ($status -ne 'parsed') {
            foreach ($k in 'Phase', 'Sealed', 'Started', 'TerminationReason', 'TerminationClass', 'Failure', 'Code') { $r[$k] = $null }
            foreach ($k in 'Codes', 'Refusals', 'Timers') { $r[$k] = @() }
            $r['Consistency'] = 'not_applicable'; $r['CompleteEligible'] = $false; $r['LauncherExitCode'] = 1
        }
        if ($ExitCode -notin 0, 1, 2) { $r['Classification'] = 'runtime_exit_unexpected' }
        elseif ($status -ne 'parsed') { $r['Classification'] = 'runtime_report_invalid' }
        [pscustomobject]$r
    }
    if ($null -eq $Bytes -or $Bytes.Length -eq 0) { return (& $finish 'absent' 'report_absent') }
    if ($Bytes.Length -gt $script:MaxReportBytes) { return (& $finish 'invalid' 'report_too_large') }
    if ($Bytes[$Bytes.Length - 1] -ne 10) { return (& $finish 'invalid' 'report_not_single_line') }
    for ($i = 0; $i -lt $Bytes.Length - 1; $i++) { if ($Bytes[$i] -eq 10 -or $Bytes[$i] -eq 13 -or $Bytes[$i] -eq 0) { return (& $finish 'invalid' 'report_not_single_line') } }
    $text = $null
    try { $text = $script:Utf8Strict.GetString($Bytes, 0, $Bytes.Length - 1) } catch { return (& $finish 'invalid' 'report_not_utf8') }
    if ($text.Length -eq 0 -or $text[0] -eq [char]0xFEFF) { return (& $finish 'invalid' 'report_not_json') }
    $v = $null
    try { $v = ConvertFrom-JsonStrict -Text $text } catch { return (& $finish 'invalid' 'report_not_json') }
    if ($v -isnot [System.Collections.IDictionary]) { return (& $finish 'invalid' 'report_not_object') }
    $keys = Get-ReportKeys -Dict $v
    if ($keys -cnotcontains 'phase') { return (& $finish 'invalid' 'report_keys_invalid') }
    $phase = $v['phase']
    if ($phase -isnot [string]) { return (& $finish 'invalid' 'report_type_invalid') }
    if ($script:Phases -cnotcontains $phase) { return (& $finish 'invalid' 'report_value_invalid') }

    $bad = $null
    $expectedExit = $null
    switch ($phase) {
        'input' { $bad = (Test-ReportKeySet $keys @('phase', 'code') @('timers')) ?? (Test-ReportString $v['code'] $script:InputCodes $true); if ($null -eq $bad) { $r['Code'] = [string]$v['code'] }; $expectedExit = 2 }
        'assembly' { $bad = (Test-ReportKeySet $keys @('phase', 'code') @('timers')) ?? (Test-ReportString $v['code'] $script:AssemblyCodes $true); if ($null -eq $bad) { $r['Code'] = [string]$v['code'] }; $expectedExit = 2 }
        'compose' { $bad = (Test-ReportKeySet $keys @('phase', 'code') @('timers')) ?? (Test-ReportString $v['code'] $script:ComposeCodes $true); if ($null -eq $bad) { $r['Code'] = [string]$v['code'] }; $expectedExit = 2 }
        'internal' {
            # main.ts writes the literal `internal_error` here and does not pass it through closed(): `unlisted` is not allowed.
            $bad = (Test-ReportKeySet $keys @('phase', 'code') @('timers')) ?? (Test-ReportString $v['code'] @('internal_error') $false); if ($null -eq $bad) { $r['Code'] = [string]$v['code'] }; $expectedExit = 1
        }
        'stage_a' {
            $bad = (Test-ReportKeySet $keys @('phase', 'codes') @('timers')) ?? (Test-ReportStringArray $v['codes'] $script:ConfigIssueCodes ($script:ConfigIssueCodes.Count + 1))
            if ($null -eq $bad) { $r['Codes'] = @($v['codes'] | ForEach-Object { [string]$_ }) }
            $expectedExit = 2
        }
        'stage_b' {
            $bad = Test-ReportKeySet $keys @('phase', 'refusals') @('timers')
            if ($null -eq $bad) {
                $list = $v['refusals']
                if ($list -isnot [System.Collections.IList]) { $bad = 'report_type_invalid' }
                elseif (@($list).Count -lt 1 -or @($list).Count -gt 64) { $bad = 'report_value_invalid' }
                else {
                    $out = [System.Collections.Generic.List[object]]::new()
                    foreach ($item in @($list)) {
                        if ($item -isnot [System.Collections.IDictionary]) { $bad = 'report_type_invalid'; break }
                        $bad = (Test-ReportKeySet (Get-ReportKeys -Dict $item) @('check', 'code') @()) ?? (Test-ReportString $item['check'] $script:StartupChecks $true) ?? (Test-ReportString $item['code'] $script:StartupRefusalCodes $true)
                        if ($null -ne $bad) { break }
                        $out.Add([pscustomobject]@{ Check = [string]$item['check']; Code = [string]$item['code'] })
                    }
                    if ($null -eq $bad) { $r['Refusals'] = $out.ToArray() }
                }
            }
            $expectedExit = 2
        }
        'run' {
            $sealed = if ($keys -ccontains 'sealed') { $v['sealed'] } else { $null }
            if ($sealed -isnot [bool]) { $bad = $(if ($keys -ccontains 'sealed') { 'report_type_invalid' } else { 'report_keys_invalid' }) }
            elseif ($sealed) {
                $bad = (Test-ReportKeySet $keys @('phase', 'sealed', 'terminationReason') @('timers')) ?? (Test-ReportString $v['terminationReason'] $script:TerminationReasons $true)
                if ($null -eq $bad) { $r['Sealed'] = $true; $r['TerminationReason'] = [string]$v['terminationReason'] }
                $expectedExit = 0
            } else {
                $bad = (Test-ReportKeySet $keys @('phase', 'sealed', 'started', 'failure') @('terminationReason', 'timers'))
                if ($null -eq $bad -and $v['started'] -isnot [bool]) { $bad = 'report_type_invalid' }
                if ($null -eq $bad) { $bad = Test-ReportString $v['failure'] $script:UnsealedFailures $true }
                if ($null -eq $bad -and $keys -ccontains 'terminationReason') { $bad = Test-ReportString $v['terminationReason'] $script:TerminationReasons $true }
                if ($null -eq $bad) {
                    $r['Sealed'] = $false; $r['Started'] = [bool]$v['started']; $r['Failure'] = [string]$v['failure']
                    if ($keys -ccontains 'terminationReason') { $r['TerminationReason'] = [string]$v['terminationReason'] }
                }
                $expectedExit = 1
            }
        }
    }
    if ($null -eq $bad -and $keys -ccontains 'timers') {
        $bad = Test-ReportStringArray $v['timers'] $script:TimerNotes $script:TimerNotes.Count
        if ($null -eq $bad) { $r['Timers'] = @($v['timers'] | ForEach-Object { [string]$_ }) }
    }
    if ($null -ne $bad) { return (& $finish 'invalid' $bad) }

    $r['Phase'] = $phase
    if ($null -ne $r['TerminationReason']) { $r['TerminationClass'] = Get-RuntimeTerminationClass -Reason $r['TerminationReason'] }
    $r['Status'] = 'parsed'; $r['ReportCode'] = $null
    if ($ExitCode -notin 0, 1, 2) { $r['Classification'] = 'runtime_exit_unexpected'; return [pscustomobject]$r }
    if ($ExitCode -ne $expectedExit) { $r['Consistency'] = 'inconsistent'; $r['Classification'] = 'runtime_report_inconsistent'; return [pscustomobject]$r }
    $r['Consistency'] = 'consistent'
    switch ($ExitCode) {
        0 {
            if ($r['TerminationClass'] -ceq 'normal') { $r['Classification'] = 'runtime_sealed_normal'; $r['CompleteEligible'] = $true; $r['LauncherExitCode'] = 0 }
            else { $r['Classification'] = 'runtime_sealed_abnormal' }
        }
        1 { $r['Classification'] = 'runtime_unsealed' }
        2 { $r['Classification'] = 'runtime_refused' }
    }
    [pscustomobject]$r
}

Export-ModuleMember -Function Get-RuntimeReportVocabulary, Get-RuntimeTerminationClass, ConvertFrom-RuntimeReport