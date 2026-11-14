#Requires -Version 7.0
# Lease timing settings, the three rules, and the lease-timing measurement record (design "Lease timing"; tasks 2.18 and 2.27).
# Shared by the Launcher (Start-DiscoveryRun.ps1) and the measurement (Measure-LeaseTiming.ps1). It writes no file.
#
# The record is an OBSERVATION record, not a guarantee: a valid record means only that a measurement under the recorded conditions
# was made and that its numbers meet the rules. Nothing that uses it may claim a verified stop time beyond those conditions.
# Until a valid record from a real measurement exists, the 10-second stop of R24.12 is UNVERIFIED and no Discovery Run starts.
Set-StrictMode -Version Latest
Import-Module (Join-Path $PSScriptRoot 'DiscoveryCommon.psm1') -DisableNameChecking

$script:AbortBudgetMs = 2000
$script:JitterMs = 250
$script:StopLimitMs = 10000
$script:RecordKind = 'lease-timing-measurement'
$script:MinBeats = 300
$script:MinHealthyTrials = 10
$script:MinStoppedTrials = 5
$script:MinKillSamples = 10
$script:Statement = 'Measured under the recorded conditions only. Not verified for another machine, Docker version, setting, or load.'

# The settings of this project (design defaults). P = min(500, H / 2); the host tools require H to be even so that P is an integer.
function Get-LeaseSettings {
    [ordered]@{ heartbeatIntervalMs = 1000; staleAfterMs = 4000 }
}

function Get-WatchIntervalMs { param([long]$HeartbeatIntervalMs) [long][Math]::Min(500, [Math]::Floor($HeartbeatIntervalMs / 2)) }

# The settings H, P, S, A, J as one object, and its hash (canonical JSON, SHA-256).
function Get-LeaseTimingSettings {
    param([Parameter(Mandatory)]$Settings)
    [ordered]@{
        abortBudgetMs = [long]$script:AbortBudgetMs
        heartbeatIntervalMs = [long]$Settings.heartbeatIntervalMs
        jitterMs = [long]$script:JitterMs
        staleAfterMs = [long]$Settings.staleAfterMs
        watchIntervalMs = Get-WatchIntervalMs -HeartbeatIntervalMs ([long]$Settings.heartbeatIntervalMs)
    }
}

function Get-LeaseSettingsSha256 {
    param([Parameter(Mandatory)]$Settings)
    Get-Sha256HexOfText -Text (ConvertTo-CanonicalJson -Value (Get-LeaseTimingSettings -Settings $Settings))
}

# Ranges and the three rules with the measured D. Returns the list of failed rule codes (empty when the settings are valid).
#   1. S >= 3 H     2. S >= H + 2 P + D + J     3. S + P + D + A <= 10000
function Test-LeaseTimingRules {
    param([Parameter(Mandatory)]$Settings, $MeasuredDelayMs)
    $errors = [System.Collections.Generic.List[string]]::new()
    $h = $Settings.heartbeatIntervalMs; $s = $Settings.staleAfterMs
    $isInt = { param($v) ($v -is [int] -or $v -is [long]) }
    if (-not (& $isInt $h) -or $h -lt 500 -or $h -gt 2000 -or ($h % 2) -ne 0) { $errors.Add('heartbeat_interval_out_of_range') }
    if (-not (& $isInt $s) -or $s -lt 1 -or $s -gt 6000) { $errors.Add('stale_after_out_of_range') }
    $d = $MeasuredDelayMs
    if ($null -eq $d -or -not (($d -is [int]) -or ($d -is [long]) -or ($d -is [double])) -or [double]::IsNaN([double]$d) -or [double]::IsInfinity([double]$d) -or [double]$d -lt 0) { $errors.Add('propagation_delay_unmeasured') }
    if ($errors.Count -gt 0) { return , $errors.ToArray() }
    $p = Get-WatchIntervalMs -HeartbeatIntervalMs $h
    $d = [double]$d
    if ($s -lt 3 * $h) { $errors.Add('rule_1_stale_below_three_heartbeats') }
    if ($s -lt $h + 2 * $p + $d + $script:JitterMs) { $errors.Add('rule_2_healthy_launcher_could_be_judged_stale') }
    if ($s + $p + $d + $script:AbortBudgetMs -gt $script:StopLimitMs) { $errors.Add('rule_3_stop_exceeds_ten_seconds') }
    , $errors.ToArray()
}

function Get-Percentile {
    param([double[]]$Values, [double]$Fraction)
    if ($Values.Count -eq 0) { return 0 }
    $sorted = [double[]]($Values | Sort-Object)
    $i = [Math]::Ceiling($Fraction * $sorted.Count) - 1
    $sorted[[Math]::Max(0, [Math]::Min($sorted.Count - 1, $i))]
}

# Builds the record from raw measurement numbers. Only the numbers are taken from the measurement; the maxima are computed here.
function New-LeaseTimingRecord {
    param(
        [Parameter(Mandatory)]$Settings,
        [Parameter(Mandatory)][string]$MeasuredAt,
        [Parameter(Mandatory)]$Docker,              # serverVersion, os, osType, kernelVersion, architecture (as reported by Docker)
        [Parameter(Mandatory)][string]$ProbeImageDigest,
        [Parameter(Mandatory)][string]$LeaseMount,
        [Parameter(Mandatory)][AllowEmptyCollection()][long[]]$RoundTripsMs,
        [Parameter(Mandatory)][AllowEmptyCollection()][long[]]$GapsMs,
        [Parameter(Mandatory)][long]$HealthyTrials, [Parameter(Mandatory)][long]$HealthyPassed,
        [Parameter(Mandatory)][long]$StoppedTrials, [Parameter(Mandatory)][long]$StoppedRefused, [Parameter(Mandatory)][long]$StoppedRequests,
        [Parameter(Mandatory)][AllowEmptyCollection()][long[]]$KillSamplesMs
    )
    $rt = [double[]]$RoundTripsMs
    [ordered]@{
        kind = $script:RecordKind
        schemaVersion = [long]1
        measuredAt = $MeasuredAt
        settings = Get-LeaseTimingSettings -Settings $Settings
        settingsSha256 = Get-LeaseSettingsSha256 -Settings $Settings
        docker = [ordered]@{ serverVersion = [string]$Docker.serverVersion; os = [string]$Docker.os; osType = [string]$Docker.osType; kernelVersion = [string]$Docker.kernelVersion; architecture = [string]$Docker.architecture }
        probeImageDigest = $ProbeImageDigest
        leaseMount = $LeaseMount
        propagation = [ordered]@{
            beats = [long]$RoundTripsMs.Count
            roundTripsMs = [long[]]$RoundTripsMs
            maxRoundTripMs = $(if ($RoundTripsMs.Count -gt 0) { [long]($RoundTripsMs | Measure-Object -Maximum).Maximum } else { [long]0 })
            p99RoundTripMs = [long](Get-Percentile -Values $rt -Fraction 0.99)
            maxGapMs = $(if ($GapsMs.Count -gt 0) { [long]($GapsMs | Measure-Object -Maximum).Maximum } else { [long]0 })
        }
        startup = [ordered]@{ healthyTrials = $HealthyTrials; healthyPassed = $HealthyPassed; stoppedTrials = $StoppedTrials; stoppedRefused = $StoppedRefused; stoppedRequests = $StoppedRequests }
        kill = [ordered]@{
            samplesMs = [long[]]$KillSamplesMs
            maxMs = $(if ($KillSamplesMs.Count -gt 0) { [long]($KillSamplesMs | Measure-Object -Maximum).Maximum } else { [long]0 })
        }
        statement = $script:Statement
    }
}

# Validates a record against the current settings and Docker server version. It recomputes everything and trusts nothing in the
# file except the measured numbers (the round trips, the counts, and the kill samples).
# Result: Ok, Code ('lease_timing_unmeasured' | 'lease_timing_invalid' | $null), Problems, D, RecordSha256.
function Test-LeaseTimingRecord {
    [CmdletBinding()]
    param([string]$Path, [Parameter(Mandatory)]$Settings, [Parameter(Mandatory)][AllowEmptyString()][string]$DockerServerVersion)
    $problems = [System.Collections.Generic.List[string]]::new()
    $fail = { param($code) [pscustomobject]@{ Ok = $false; Code = $code; Problems = $problems.ToArray(); D = $null; RecordSha256 = $null } }
    if (-not $Path -or -not (Test-Path -LiteralPath $Path -PathType Leaf)) { $problems.Add('record_missing'); return (& $fail 'lease_timing_unmeasured') }
    $bytes = [System.IO.File]::ReadAllBytes($Path)
    $sha = Get-Sha256Hex -Bytes $bytes
    try { $r = ConvertFrom-JsonStrict -Text ([System.Text.UTF8Encoding]::new($false, $true).GetString($bytes)) } catch { $problems.Add('record_not_json'); return (& $fail 'lease_timing_unmeasured') }
    if ($r -isnot [System.Collections.IDictionary]) { $problems.Add('record_not_object'); return (& $fail 'lease_timing_unmeasured') }
    $get = { param($o, $k) if ($o -is [System.Collections.IDictionary] -and $o.Contains($k)) { $o[$k] } else { $null } }
    $isCount = { param($v) ($v -is [long] -or $v -is [int]) -and $v -ge 0 }
    if ((& $get $r 'kind') -cne $script:RecordKind) { $problems.Add('kind') }
    if ((& $get $r 'schemaVersion') -ne 1 -or (& $get $r 'schemaVersion') -isnot [long]) { $problems.Add('schemaVersion') }
    if ((& $get $r 'settingsSha256') -cne (Get-LeaseSettingsSha256 -Settings $Settings)) { $problems.Add('settings_hash_differs') }
    $recordedSettings = & $get $r 'settings'
    if ($null -eq $recordedSettings -or (ConvertTo-CanonicalJson -Value $recordedSettings) -cne (ConvertTo-CanonicalJson -Value (Get-LeaseTimingSettings -Settings $Settings))) { $problems.Add('settings_differ') }
    $docker = & $get $r 'docker'
    if ([string]::IsNullOrEmpty($DockerServerVersion) -or (& $get $docker 'serverVersion') -cne $DockerServerVersion) { $problems.Add('docker_server_version_differs') }
    if ((& $get $r 'measuredAt') -isnot [string]) { $problems.Add('measuredAt') }
    if ((& $get $r 'probeImageDigest') -isnot [string] -or (& $get $r 'probeImageDigest') -cnotmatch '^sha256:[0-9a-f]{64}$') { $problems.Add('probeImageDigest') }
    if ((& $get $r 'leaseMount') -isnot [string]) { $problems.Add('leaseMount') }

    $prop = & $get $r 'propagation'
    $rts = & $get $prop 'roundTripsMs'
    $d = $null
    if ($null -eq $rts -or $rts -is [string] -or @($rts | Where-Object { -not (& $isCount $_) }).Count -gt 0) { $problems.Add('propagation_samples') }
    else {
        $list = @($rts)
        if ($list.Count -lt $script:MinBeats) { $problems.Add('too_few_beats') }
        if ($list.Count -gt 0) { $d = [long]($list | Measure-Object -Maximum).Maximum }
        else { $problems.Add('propagation_delay_unmeasured') }
    }
    $st = & $get $r 'startup'
    foreach ($k in 'healthyTrials', 'healthyPassed', 'stoppedTrials', 'stoppedRefused', 'stoppedRequests') { if (-not (& $isCount (& $get $st $k))) { $problems.Add("startup_$k") } }
    if (@($problems | Where-Object { $_ -like 'startup_*' }).Count -eq 0) {
        if ((& $get $st 'healthyTrials') -lt $script:MinHealthyTrials) { $problems.Add('too_few_healthy_trials') }
        if ((& $get $st 'healthyPassed') -ne (& $get $st 'healthyTrials')) { $problems.Add('healthy_trial_refused') }
        if ((& $get $st 'stoppedTrials') -lt $script:MinStoppedTrials) { $problems.Add('too_few_stopped_trials') }
        if ((& $get $st 'stoppedRefused') -ne (& $get $st 'stoppedTrials')) { $problems.Add('stopped_writer_passed') }
        if ((& $get $st 'stoppedRequests') -ne 0) { $problems.Add('request_sent_by_stopped_trial') }
    }
    $kill = & $get $r 'kill'
    $samples = & $get $kill 'samplesMs'
    if ($null -eq $samples -or $samples -is [string] -or @($samples | Where-Object { -not (& $isCount $_) }).Count -gt 0) { $problems.Add('kill_samples') }
    else {
        $ks = @($samples)
        if ($ks.Count -lt $script:MinKillSamples) { $problems.Add('too_few_kill_samples') }
        if (@($ks | Where-Object { $_ -gt $script:StopLimitMs }).Count -gt 0) { $problems.Add('kill_sample_above_10000_ms') }
    }
    if ($problems.Count -gt 0) { return (& $fail 'lease_timing_unmeasured') }
    $rules = Test-LeaseTimingRules -Settings $Settings -MeasuredDelayMs $d
    foreach ($x in $rules) { $problems.Add($x) }
    if ($problems.Count -gt 0) { return [pscustomobject]@{ Ok = $false; Code = 'lease_timing_invalid'; Problems = $problems.ToArray(); D = $d; RecordSha256 = $sha } }
    [pscustomobject]@{ Ok = $true; Code = $null; Problems = @(); D = $d; RecordSha256 = $sha }
}

function Get-LeaseTimingStatement { $script:Statement }

Export-ModuleMember -Function Get-LeaseSettings, Get-WatchIntervalMs, Get-LeaseTimingSettings, Get-LeaseSettingsSha256, Test-LeaseTimingRules, New-LeaseTimingRecord, Test-LeaseTimingRecord, Get-LeaseTimingStatement