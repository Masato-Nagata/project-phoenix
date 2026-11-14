#Requires -Version 7.0
# Lease timing measurement (task 2.27; design "Lease timing measurement (not a Discovery Run)"). NOT a Discovery Run.
#
# It never touches the Legacy_App, the Test API, the lab network, or the override: every container it starts has --network none. It does
# not take the conformance mutex; it takes the Run-versus-Run lock, so that it never overlaps a Run. It creates no Run_Volume, no Run
# directory, no Run_Manifest, no Evidence record, and no Approval_Record. It writes only discovery/config/lease-timing.json and its own
# directories discovery/leases/measure-<id>/ and discovery/leases/measure-<id>-ack/. Every Docker call goes through Invoke-DockerCli.
#
# The record it writes is an observation record under the recorded conditions, not a guarantee (design "What the record proves").
Set-StrictMode -Version Latest
Import-Module (Join-Path $PSScriptRoot 'DiscoveryCommon.psm1') -DisableNameChecking
Import-Module (Join-Path $PSScriptRoot 'LeaseTiming.psm1') -DisableNameChecking
Import-Module (Join-Path $PSScriptRoot 'DiscoveryLauncher.psm1') -DisableNameChecking

$script:MeasureImage = 'phoenix/discovery-toolchain:m0'
$script:NodeModulesVolume = 'phoenix-node-modules'

function New-MeasureId {
    $b = [byte[]]::new(4); [System.Security.Cryptography.RandomNumberGenerator]::Fill($b)
    [DateTimeOffset]::UtcNow.ToString('yyyyMMddTHHmmssZ', [System.Globalization.CultureInfo]::InvariantCulture) + '-' + [Convert]::ToHexString($b).ToLowerInvariant()
}

function Get-DockerFacts {
    $r = Invoke-DockerCli -Arguments @('version', '--format', '{{.Server.Version}}|{{.Server.Os}}|{{.Server.Arch}}|{{.Server.KernelVersion}}')
    $p = $r.Output.Trim().Split('|')
    $info = (Invoke-DockerCli -Arguments @('info', '--format', '{{.OperatingSystem}}')).Output.Trim()
    [pscustomobject]@{ serverVersion = [string]$p[0]; osType = $(if ($p.Count -gt 1) { [string]$p[1] } else { '' }); architecture = $(if ($p.Count -gt 2) { [string]$p[2] } else { '' }); kernelVersion = $(if ($p.Count -gt 3) { [string]$p[3] } else { '' }); os = $info }
}

function New-MeasureContainerArgs {
    param([Parameter(Mandatory)][string]$Name, [Parameter(Mandatory)][ValidateSet('propagate', 'startup', 'kill')][string]$Mode,
          [Parameter(Mandatory)][string]$RepoRoot, [Parameter(Mandatory)][string]$LeaseDir, [Parameter(Mandatory)][string]$AckDir,
          [Parameter(Mandatory)][string]$MeasureRunId, [Parameter(Mandatory)][string]$Nonce, [Parameter(Mandatory)]$Settings)
    $repo = [System.IO.Path]::GetFullPath($RepoRoot)
    , @('run', '-d', '--name', $Name, '--network', 'none', '--read-only', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges:true',
        '--user', '10001:10001', '--tmpfs', '/tmp:rw,size=16m', '--memory', '512m', '--cpus', '1', '--pids-limit', '64',
        '--label', 'phoenix.discovery.role=lease-measure',
        '--env', "PHOENIX_MEASURE_MODE=$Mode", '--env', "PHOENIX_RUN_ID=$MeasureRunId", '--env', "PHOENIX_LEASE_NONCE=$Nonce",
        '--env', "PHOENIX_LEASE_H_MS=$($Settings.heartbeatIntervalMs)", '--env', "PHOENIX_LEASE_S_MS=$($Settings.staleAfterMs)",
        '--mount', "type=bind,source=$LeaseDir,target=/run/lease,readonly", '--mount', "type=bind,source=$AckDir,target=/run/ack",
        '--mount', "type=bind,source=$(Join-Path $repo 'packages'),target=/workspace/packages,readonly",
        '--mount', "type=volume,source=$script:NodeModulesVolume,target=/workspace/node_modules,readonly",
        '--workdir', '/workspace', $script:MeasureImage, 'node', '/workspace/packages/verifier/dist/leaseMeasure/main.js')
}

function Clear-Directory {
    param([string]$Path)
    if (-not (Test-Path -LiteralPath $Path)) { [void][System.IO.Directory]::CreateDirectory($Path); return }
    foreach ($i in Get-ChildItem -LiteralPath $Path -Force) { Remove-Item -LiteralPath $i.FullName -Recurse -Force }
}

# A fresh lease in the measurement's own directory: lease.json and the counter 1 (the format of the Launcher).
function Reset-MeasureLease {
    param([string]$LeaseDir, [string]$AckDir, [string]$MeasureRunId, [string]$Nonce, $Settings)
    if (Test-Path -LiteralPath $LeaseDir) { Remove-Item -LiteralPath $LeaseDir -Recurse -Force }
    Clear-Directory -Path $AckDir
    New-RunLease -LeaseDir $LeaseDir -RunId $MeasureRunId -Nonce $Nonce -Settings $Settings
}

function Wait-Until {
    param([scriptblock]$Condition, [long]$TimeoutMs, [int]$PollMs = 2)
    $sw = [System.Diagnostics.Stopwatch]::StartNew()
    while ($sw.ElapsedMilliseconds -lt $TimeoutMs) { if (& $Condition) { return $true }; Start-Sleep -Milliseconds $PollMs }
    [bool](& $Condition)
}

function Remove-MeasureContainer { param([string]$Name) [void](Invoke-DockerCli -Arguments @('rm', '--force', $Name)) }

# A writer process: a separate pwsh that renews the counter at the interval H (the Launcher's heartbeat code), until it is killed.
function Start-LeaseWriterProcess {
    param([string]$WriterScript, [string]$LeaseDir, [long]$IntervalMs, [string]$DiagPath)
    $psi = [System.Diagnostics.ProcessStartInfo]::new((Get-Process -Id $PID).Path)
    foreach ($a in @('-NoProfile', '-NonInteractive', '-File', $WriterScript, '-LeaseDir', $LeaseDir, '-IntervalMs', [string]$IntervalMs)) { $psi.ArgumentList.Add($a) }
    if ($DiagPath) { $psi.ArgumentList.Add('-DiagPath'); $psi.ArgumentList.Add($DiagPath) }
    $psi.UseShellExecute = $false; $psi.RedirectStandardOutput = $true; $psi.RedirectStandardError = $true
    [System.Diagnostics.Process]::Start($psi)
}

function Invoke-LeaseTimingMeasurement {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)][string]$RepoRoot, [Parameter(Mandatory)][string]$LockPath, [Parameter(Mandatory)]$Settings,
        [Parameter(Mandatory)][int]$Beats, [Parameter(Mandatory)][int]$HealthyTrials, [Parameter(Mandatory)][int]$StoppedTrials, [Parameter(Mandatory)][int]$KillTrials,
        [Parameter(Mandatory)][string]$WriterScript, [string]$RecordPath, [scriptblock]$Log = { param($m) Write-Host $m }
    )
    if (-not $RecordPath) { $RecordPath = Join-Path $RepoRoot 'discovery/config/lease-timing.json' }
    $rules = Test-LeaseTimingRules -Settings $Settings -MeasuredDelayMs 0
    if ($rules.Count -gt 0) { return [pscustomobject]@{ ExitCode = 2; Code = 'lease_timing_invalid'; Problems = $rules; RecordPath = $null } }
    $lock = Enter-RunLock -LockPath $LockPath
    if ($null -eq $lock) { return [pscustomobject]@{ ExitCode = 2; Code = 'run_lock'; Problems = @(); RecordPath = $null } }
    $id = New-MeasureId
    $leaseDir = Join-Path $RepoRoot "discovery/leases/measure-$id"
    $ackDir = Join-Path $RepoRoot "discovery/leases/measure-$id-ack"
    $runId = "measure-$id"
    $h = [long]$Settings.heartbeatIntervalMs; $s = [long]$Settings.staleAfterMs
    $containers = [System.Collections.Generic.List[string]]::new()
    $writer = $null
    # Diagnostics only (2026-11-13): the real elapsed time of every heartbeat write and its lateness. Not part of the record and not
    # used by any rule; written next to the measurement directories and kept on failure.
    $diagPath = Join-Path $RepoRoot "discovery/leases/measure-$id-heartbeat.json"
    $writerDiag = Join-Path $RepoRoot "discovery/leases/measure-$id-writer.log"
    $jDiag = [long]((Get-LeaseTimingSettings -Settings $Settings).jitterMs)
    $hbDiag = [System.Collections.Generic.List[object]]::new()
    $writeDiag = {
        $w = @($hbDiag | ForEach-Object { $_.writeMs }); $l = @($hbDiag | ForEach-Object { $_.lateMs }); $g = @($hbDiag | Where-Object { $_.gapMs -ge 0 } | ForEach-Object { $_.gapMs })
        $o = [ordered]@{
            kind = 'lease-measure-heartbeat-diagnostics'; measureId = $id; heartbeatIntervalMs = $h; jitterMs = $jDiag
            replace = [ordered]@{ budgetMs = (Get-AtomicReplaceSettings).RetryBudgetMs; guardMs = (Get-AtomicReplaceSettings).RetryGuardMs }
            beats = [long]$hbDiag.Count
            maxWriteMs = $(if ($w.Count) { [long]($w | Measure-Object -Maximum).Maximum } else { [long]0 })
            maxLateMs = $(if ($l.Count) { [long]($l | Measure-Object -Maximum).Maximum } else { [long]0 })
            maxGapMs = $(if ($g.Count) { [long]($g | Measure-Object -Maximum).Maximum } else { [long]0 })
            gapsAboveHPlusJ = [long]@($g | Where-Object { $_ -gt $h + $jDiag }).Count
            retriedWrites = [long]@($hbDiag | Where-Object { $_.attempts -gt 1 }).Count
            maxAttempts = $(if ($hbDiag.Count) { [long]($hbDiag | ForEach-Object { $_.attempts } | Measure-Object -Maximum).Maximum } else { [long]0 })
            perBeat = @($hbDiag | ForEach-Object { [ordered]@{ attempts = [long]$_.attempts; gapMs = [long]$_.gapMs; lateMs = [long]$_.lateMs; value = [long]$_.value; writeMs = [long]$_.writeMs } })
        }
        $dir = Split-Path -Parent $diagPath; if (-not (Test-Path -LiteralPath $dir)) { [void][System.IO.Directory]::CreateDirectory($dir) }
        [System.IO.File]::WriteAllText($diagPath, (ConvertTo-CanonicalJson -Value $o) + "`n", [System.Text.UTF8Encoding]::new($false))
        $o
    }
    try {
        $facts = Get-DockerFacts
        $digest = (Invoke-DockerCli -Arguments @('image', 'inspect', '--format', '{{.Id}}', $script:MeasureImage)).Output.Trim()
        $nonce = New-LeaseNonce
        $script:n = 0   # the container counter of this measurement (module scope, used by $start)
        $start = {
            param($mode)
            $script:n++
            $name = "phoenix-lease-measure-$id-$($script:n)"
            $containers.Add($name)
            $r = Invoke-DockerCli -Arguments (New-MeasureContainerArgs -Name $name -Mode $mode -RepoRoot $RepoRoot -LeaseDir $leaseDir -AckDir $ackDir -MeasureRunId $runId -Nonce $nonce -Settings $Settings)
            if ($r.ExitCode -ne 0) { throw "the measurement container did not start ($mode)" }
            $name
        }
        $stopped = { param($name) -not (Test-ContainerRunning -Container $name) }

        # 1. Propagation: the host writes the counter at the interval H; the container acknowledges each new value.
        & $Log "propagation: $Beats beats at $h ms"
        $lease = Reset-MeasureLease -LeaseDir $leaseDir -AckDir $ackDir -MeasureRunId $runId -Nonce $nonce -Settings $Settings
        $c = & $start 'propagate'
        if (-not (Wait-Until { Test-Path -LiteralPath (Join-Path $ackDir 'beat-1') } (60000))) { throw 'the propagation container did not acknowledge the first value' }
        $rtts = [System.Collections.Generic.List[long]]::new()
        $sw = [System.Diagnostics.Stopwatch]::StartNew()
        $next = $sw.ElapsedMilliseconds
        $prevDone = [long]0
        for ($k = 0; $k -lt $Beats; $k++) {
            $next += $h
            $wait = $next - $sw.ElapsedMilliseconds
            if ($wait -gt 0) { Start-Sleep -Milliseconds $wait }
            $ws = $sw.ElapsedMilliseconds
            $value = Step-LeaseHeartbeat -Lease $lease
            $t0 = $sw.ElapsedMilliseconds
            $lr = Get-LastAtomicReplace
            $hbDiag.Add([pscustomobject]@{ value = $value; lateMs = [long][Math]::Max(0, $ws - $next); writeMs = [long]($t0 - $ws); attempts = [long]$lr.Attempts; gapMs = $(if ($hbDiag.Count -gt 0) { [long]($t0 - $prevDone) } else { [long]-1 }) })
            $prevDone = $t0
            $ackFile = Join-Path $ackDir "beat-$value"
            if (-not (Wait-Until { Test-Path -LiteralPath $ackFile } $s)) { throw "no acknowledgement of value $value within S" }
            $rtts.Add($sw.ElapsedMilliseconds - $t0)
        }
        Revoke-RunLease -Lease $lease
        $d0 = & $writeDiag
        & $Log "heartbeat writes: max elapsed $($d0.maxWriteMs) ms, max lateness $($d0.maxLateMs) ms, max gap $($d0.maxGapMs) ms, gaps above H + J $($d0.gapsAboveHPlusJ), retried $($d0.retriedWrites) (max attempts $($d0.maxAttempts))"
        [void](Wait-Until { Test-Path -LiteralPath (Join-Path $ackDir 'observer.json') } 30000)
        $gaps = [long[]]@()
        $obs = Join-Path $ackDir 'observer.json'
        if (Test-Path -LiteralPath $obs) { $o = ConvertFrom-JsonStrict -Text ([System.IO.File]::ReadAllText($obs)); $gaps = [long[]]@($o['gaps']) }
        [void](Wait-Until { & $stopped $c } 30000)

        # 2. Start-up proof: healthy writer trials pass; stopped writer trials are refused with zero requests.
        $healthyPassed = 0; $stoppedRefused = 0; $stoppedRequests = 0
        for ($i = 0; $i -lt $HealthyTrials + $StoppedTrials; $i++) {
            $healthy = $i -lt $HealthyTrials
            [void](Reset-MeasureLease -LeaseDir $leaseDir -AckDir $ackDir -MeasureRunId $runId -Nonce $nonce -Settings $Settings)
            if ($healthy) { $writer = Start-LeaseWriterProcess -WriterScript $WriterScript -LeaseDir $leaseDir -IntervalMs $h -DiagPath $writerDiag }
            $c = & $start 'startup'
            [void](Wait-Until { Test-Path -LiteralPath (Join-Path $ackDir 'startup.json') } ($s + 60000))
            if ($null -ne $writer) { try { $writer.Kill($true) } catch { }; $writer.WaitForExit(); $writer = $null }
            $res = Join-Path $ackDir 'startup.json'
            $r = if (Test-Path -LiteralPath $res) { ConvertFrom-JsonStrict -Text ([System.IO.File]::ReadAllText($res)) } else { @{ result = 'none'; requests = 0 } }
            if ($healthy -and $r['result'] -ceq 'passed') { $healthyPassed++ }
            if (-not $healthy) { if ($r['result'] -ceq 'refused') { $stoppedRefused++ }; $stoppedRequests += [long]$r['requests'] }
            [void](Wait-Until { & $stopped $c } 30000)
        }
        & $Log "start-up proof: $healthyPassed of $HealthyTrials healthy passed, $stoppedRefused of $StoppedTrials stopped refused"

        # 3. Kill to stop: the writer process is killed after the proof; the time until the container is not running is measured.
        $samples = [System.Collections.Generic.List[long]]::new()
        for ($i = 0; $i -lt $KillTrials; $i++) {
            [void](Reset-MeasureLease -LeaseDir $leaseDir -AckDir $ackDir -MeasureRunId $runId -Nonce $nonce -Settings $Settings)
            $writer = Start-LeaseWriterProcess -WriterScript $WriterScript -LeaseDir $leaseDir -IntervalMs $h -DiagPath $writerDiag
            $c = & $start 'kill'
            if (-not (Wait-Until { Test-Path -LiteralPath (Join-Path $ackDir 'proof-passed') } ($s + 60000))) { throw 'the kill trial did not pass the proof' }
            $kw = [System.Diagnostics.Stopwatch]::StartNew()
            Stop-Process -Id $writer.Id -Force
            $writer.WaitForExit(); $writer = $null
            if (-not (Wait-Until { & $stopped $c } 60000 20)) { throw 'the container did not stop within 60 seconds after the kill' }
            $samples.Add($kw.ElapsedMilliseconds)
        }
        & $Log "kill to stop: max $(($samples | Measure-Object -Maximum).Maximum) ms over $($samples.Count) samples"

        $record = New-LeaseTimingRecord -Settings $Settings -MeasuredAt ([DateTimeOffset]::Now.ToString("yyyy-MM-dd'T'HH:mm:ss.fffzzz", [System.Globalization.CultureInfo]::InvariantCulture)) `
            -Docker $facts -ProbeImageDigest $digest -LeaseMount 'bind (Docker Desktop, Windows host directory)' -RoundTripsMs $rtts.ToArray() -GapsMs $gaps `
            -HealthyTrials $HealthyTrials -HealthyPassed $healthyPassed -StoppedTrials $StoppedTrials -StoppedRefused $stoppedRefused -StoppedRequests $stoppedRequests -KillSamplesMs $samples.ToArray()
        $dir = Split-Path -Parent $RecordPath
        if (-not (Test-Path -LiteralPath $dir)) { [void][System.IO.Directory]::CreateDirectory($dir) }
        Write-TextAtomically -Path $RecordPath -Text ((ConvertTo-CanonicalJson -Value $record) + "`n")
        $check = Test-LeaseTimingRecord -Path $RecordPath -Settings $Settings -DockerServerVersion $facts.serverVersion
        & $Log $(if ($check.Ok) { "record valid; D = $($check.D) ms. $(Get-LeaseTimingStatement)" } else { "record written but NOT valid: $($check.Code) ($($check.Problems -join ','))" })
        [pscustomobject]@{ ExitCode = $(if ($check.Ok) { 0 } else { 1 }); Code = $(if ($check.Ok) { 'measured' } else { $check.Code }); Problems = $check.Problems; RecordPath = $RecordPath; MeasureId = $id }
    } catch {
        & $Log "measurement stopped: $($_.Exception.Message)"
        if ($hbDiag.Count -gt 0 -and -not (Test-Path -LiteralPath $diagPath)) { try { [void](& $writeDiag) } catch { } }
        throw
    } finally {
        if ($null -ne $writer) { try { $writer.Kill($true) } catch { } }
        foreach ($name in $containers) { Remove-MeasureContainer -Name $name }
        $lock.Dispose()
    }
}

Export-ModuleMember -Function New-MeasureId, Get-DockerFacts, New-MeasureContainerArgs, Invoke-LeaseTimingMeasurement