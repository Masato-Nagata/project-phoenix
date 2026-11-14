#Requires -Version 7.0
# Host-side Launcher of the AI_Discovery_Loop (tasks 2.18, 2.21, 2.22; design "Mutual Exclusion between the Run and the Conformance
# Runner", "Run_Volume and the Launcher export procedure", "Lease timing"; R12, R18.13, R18.14, R18.20, R24).
#
# SCOPE OF THE GUARANTEE (A11, R24.16, R24.19): the exclusion between a Run and the conformance runner holds for ONE HOST AND ONE
# WINDOWS LOGON SESSION ONLY. The mutex lives in the `Local\` namespace of the logon session; a conformance runner or a Launcher
# started from another logon session, another user, or another host is NOT excluded. This is a residual risk with status unresolved.
#
# Testable structure: every call of the Docker CLI goes through Invoke-DockerCli; tests replace the invoker with a fake. Lock
# acquisition is Enter-DiscoveryLocks, which takes the mutex name and the lock path as arguments; the entry point
# Start-DiscoveryRun.ps1 passes the fixed constants and has no parameter, environment variable, or configuration value for them.
Set-StrictMode -Version Latest
Import-Module (Join-Path $PSScriptRoot 'DiscoveryCommon.psm1') -DisableNameChecking
Import-Module (Join-Path $PSScriptRoot 'LeaseTiming.psm1') -DisableNameChecking
Import-Module (Join-Path $PSScriptRoot 'ApprovalStore.psm1') -DisableNameChecking

$script:ConformanceMutexName = 'Local\ProjectPhoenixGroundTruthEvaluation'
$script:RunLockRelativePath = 'discovery/locks/discovery-run.lock'
$script:ScopeNote = 'Mutual exclusion scope: one host and one Windows logon session only (Local\ mutex namespace). Exclusion across logon sessions, users, or hosts is NOT guaranteed (residual risk, status unresolved).'
$script:Utf8 = [System.Text.UTF8Encoding]::new($false)
$script:RuntimeImage = 'phoenix/discovery-runtime:m4'
$script:ProbeImage = 'phoenix/discovery-toolchain:m0'
# The pinned base image of the toolchain (infra/discovery/toolchain.Dockerfile, FROM line). A test checks that both agree.
$script:HelperImage = 'docker.io/library/node:26.13.0-trixie-slim@sha256:5adad64f9a1fca2d51972caa65983634c8a774eb300d72b20f7f2a0f60368072'
$script:RuntimeUid = '10001:10001'
$script:LabNetwork = 'phoenix-discovery-lab'
$script:NodeModulesVolume = 'phoenix-node-modules'
$script:MaxRunSeconds = 1800 + 120   # the default total Run time limit (R11.10) plus the abort and seal time

function Get-LauncherConstants {
    [pscustomobject]@{
        ConformanceMutexName = $script:ConformanceMutexName; RunLockRelativePath = $script:RunLockRelativePath; ScopeNote = $script:ScopeNote
        RuntimeImage = $script:RuntimeImage; ProbeImage = $script:ProbeImage; HelperImage = $script:HelperImage; LabNetwork = $script:LabNetwork
    }
}

# ---------------------------------------------------------------------------------------------------------------------
# The one Docker entry point.
$script:DockerInvoker = {
    param([string[]]$Arguments)
    $psi = [System.Diagnostics.ProcessStartInfo]::new('docker')
    foreach ($a in $Arguments) { $psi.ArgumentList.Add($a) }
    $psi.RedirectStandardOutput = $true; $psi.RedirectStandardError = $true; $psi.UseShellExecute = $false
    $p = [System.Diagnostics.Process]::Start($psi)
    $out = $p.StandardOutput.ReadToEndAsync(); $err = $p.StandardError.ReadToEndAsync()
    $p.WaitForExit()
    [pscustomobject]@{ ExitCode = $p.ExitCode; Output = $out.Result; Error = $err.Result }
}

function Invoke-DockerCli {
    param([Parameter(Mandatory)][string[]]$Arguments)
    $r = & $script:DockerInvoker $Arguments
    [pscustomobject]@{ ExitCode = [int]$r.ExitCode; Output = [string]$r.Output; Error = [string]$r.Error }
}

# For tests only: replaces the Docker invoker. The entry point never calls it (a static test checks that).
function Set-DockerCliInvoker { param([Parameter(Mandatory)][scriptblock]$Invoker) $script:DockerInvoker = $Invoker }

# Time hooks (tests replace them so that the heartbeat loop runs on a fake clock).
$script:Clock = [System.Diagnostics.Stopwatch]::StartNew()
$script:NowMs = { [long]$script:Clock.Elapsed.TotalMilliseconds }
$script:SleepMs = { param([long]$ms) if ($ms -gt 0) { Start-Sleep -Milliseconds $ms } }
function Set-LauncherTimeHooks { param([Parameter(Mandatory)][scriptblock]$NowMs, [Parameter(Mandatory)][scriptblock]$SleepMs) $script:NowMs = $NowMs; $script:SleepMs = $SleepMs }

# ---------------------------------------------------------------------------------------------------------------------
# Locks (R24.4, R24.5, R24.8, R24.10, R24.17). Zero wait for both. The Run lock is taken first, then the conformance mutex.
# Result: Ok, Code (conformance_mutex | run_lock | conformance_mutex_abandoned), Mutex, LockStream.
# The Run-versus-Run lock alone: an exclusive file handle, zero wait. Used by the Launcher (with the mutex) and by the lease timing
# measurement (without the mutex: the measurement does not touch the Legacy_App). Returns the stream, or $null when it is held.
function Enter-RunLock {
    param([Parameter(Mandatory)][string]$LockPath)
    $dir = Split-Path -Parent $LockPath
    if ($dir -and -not (Test-Path -LiteralPath $dir -PathType Container)) { [void][System.IO.Directory]::CreateDirectory($dir) }
    try { [System.IO.FileStream]::new($LockPath, [System.IO.FileMode]::OpenOrCreate, [System.IO.FileAccess]::ReadWrite, [System.IO.FileShare]::None) }
    catch { $null }
}

function Enter-DiscoveryLocks {
    [CmdletBinding()]
    param([Parameter(Mandatory)][string]$MutexName, [Parameter(Mandatory)][string]$LockPath)
    $stream = Enter-RunLock -LockPath $LockPath
    if ($null -eq $stream) { return [pscustomobject]@{ Ok = $false; Code = 'run_lock'; Mutex = $null; LockStream = $null } }
    $mutex = [System.Threading.Mutex]::new($false, $MutexName)
    $owned = $false
    try {
        $owned = $mutex.WaitOne(0)
    } catch [System.Threading.AbandonedMutexException] {
        # The caller owns the mutex now, but in the abandoned state: this start attempt is a failure (R24.17). Release everything.
        try { $mutex.ReleaseMutex() } catch { }
        $mutex.Dispose()
        $stream.Dispose()
        return [pscustomobject]@{ Ok = $false; Code = 'conformance_mutex_abandoned'; Mutex = $null; LockStream = $null }
    }
    if (-not $owned) {
        $mutex.Dispose()
        $stream.Dispose()
        return [pscustomobject]@{ Ok = $false; Code = 'conformance_mutex'; Mutex = $null; LockStream = $null }
    }
    [pscustomobject]@{ Ok = $true; Code = $null; Mutex = $mutex; LockStream = $stream }
}

function Exit-ConformanceMutex {
    param($Locks)
    if ($null -ne $Locks -and $null -ne $Locks.Mutex) {
        try { $Locks.Mutex.ReleaseMutex() } catch { }
        $Locks.Mutex.Dispose()
        $Locks.Mutex = $null
    }
}

function Exit-RunLock {
    param($Locks)
    if ($null -ne $Locks -and $null -ne $Locks.LockStream) { $Locks.LockStream.Dispose(); $Locks.LockStream = $null }
}

# ---------------------------------------------------------------------------------------------------------------------
# Run identifier: UTC date and time plus 12 random hexadecimal digits from a cryptographic generator. It matches the RunId pattern
# of the M1 approval schema and the Docker volume name rules.
function New-DiscoveryRunId {
    param([DateTimeOffset]$Now = [DateTimeOffset]::UtcNow)
    $bytes = [byte[]]::new(6)
    [System.Security.Cryptography.RandomNumberGenerator]::Fill($bytes)
    'run-' + $Now.UtcDateTime.ToString('yyyyMMddTHHmmssZ', [System.Globalization.CultureInfo]::InvariantCulture) + '-' + [Convert]::ToHexString($bytes).ToLowerInvariant()
}

function Test-RunIdFormat { param([string]$RunId) $RunId -cmatch '^run-[0-9]{8}T[0-9]{6}Z-[0-9a-f]{12}$' }

function Get-RunPaths {
    param([Parameter(Mandatory)][string]$RepoRoot, [Parameter(Mandatory)][string]$RunId)
    $runs = Join-Path $RepoRoot 'discovery/runs'
    [pscustomobject]@{
        Runs = $runs
        Incoming = Join-Path $runs '.incoming'
        Final = Join-Path $runs $RunId
        Export = Join-Path (Join-Path $runs '.incoming') $RunId
        Lease = Join-Path (Join-Path $RepoRoot 'discovery/leases') $RunId
        Volume = "phoenix-run-$RunId"
    }
}

# A Run identifier is free only if no Run_Volume, no Run directory, no Incoming_Export, and no lease directory of that name exists (R12.2).
function Test-RunIdFree {
    param([Parameter(Mandatory)][string]$RepoRoot, [Parameter(Mandatory)][string]$RunId)
    $p = Get-RunPaths -RepoRoot $RepoRoot -RunId $RunId
    $taken = [System.Collections.Generic.List[string]]::new()
    if ((Invoke-DockerCli -Arguments @('volume', 'inspect', $p.Volume)).ExitCode -eq 0) { $taken.Add('run_volume') }
    if (Test-Path -LiteralPath $p.Final) { $taken.Add('run_directory') }
    if (Test-Path -LiteralPath $p.Export) { $taken.Add('incoming_export') }
    if (Test-Path -LiteralPath $p.Lease) { $taken.Add('lease_directory') }
    [pscustomobject]@{ Free = ($taken.Count -eq 0); Taken = $taken.ToArray() }
}

# ---------------------------------------------------------------------------------------------------------------------
# Writing helpers of the Launcher (lease, Reason_File, marker, Launcher record). Never used for the Approval_Store.
# Atomic replace (temporary file, then a rename over the target in the same directory) with a BOUNDED retry of a transient denial.
#
# Observed 2026-11-13 (task 2.27): Windows refuses to rename over a file while any other handle to that file is open, whatever share
# mode the reader used (UnauthorizedAccessException, HRESULT 0x80070005). Through a Docker Desktop bind mount, a container reading the
# heartbeat every 5 ms caused 6 of 30 renames to be refused at the first try; every one succeeded on retry within 51 ms. A mount
# without reads, or reads every 500 ms (P), caused no refusal. The refusal ends when the reader closes its handle.
#
# Retried: a sharing or lock violation (0x80070020, 0x80070021), and an access denial (0x80070005) only while the target is an
# existing regular file without the read-only attribute. Nothing else is retried. The budget is the jitter allowance J of the lease
# timing rules (250 ms): a write delayed by at most J stays inside rule 2, so H, S, D, P, A, J, and U are unchanged. When the budget
# is spent the original error is thrown (fail closed); the target keeps its previous complete content and the temporary file is removed.
$script:ReplaceRetryBudgetMs = 250
$script:ReplaceRetryPollMs = 5
# No new attempt starts unless elapsed + guard <= budget. The guard covers one iteration as measured on this host (2026-11-13): a failed
# rename up to 9.5 ms, a 5 ms sleep up to 20.9 ms (Windows timer tick), plus the exception handling and the classification.
$script:ReplaceRetryGuardMs = 50
$script:LastReplace = [pscustomobject]@{ Attempts = 0; ElapsedMs = 0L; Outcome = 'none' }

function Test-TransientReplaceDenial {
    param([Parameter(Mandatory)][System.Exception]$Exception, [Parameter(Mandatory)][string]$Target)
    $hr = $Exception.HResult
    if ((($hr -shr 16) -band 0x1FFF) -ne 7) { return $false }   # not a Win32 error
    $code = $hr -band 0xFFFF
    if ($Exception -is [System.IO.IOException] -and ($code -eq 32 -or $code -eq 33)) { return $true }
    if ($Exception -is [System.UnauthorizedAccessException] -and $code -eq 5) {
        if (-not [System.IO.File]::Exists($Target)) { return $false }
        $attr = [System.IO.File]::GetAttributes($Target)
        return -not ($attr.HasFlag([System.IO.FileAttributes]::ReadOnly) -or $attr.HasFlag([System.IO.FileAttributes]::Directory))
    }
    $false
}

function Get-AtomicReplaceSettings { [pscustomobject]@{ RetryBudgetMs = [long]$script:ReplaceRetryBudgetMs; RetryPollMs = [long]$script:ReplaceRetryPollMs; RetryGuardMs = [long]$script:ReplaceRetryGuardMs } }
function Get-LastAtomicReplace { $script:LastReplace }

function Write-TextAtomically {
    param([Parameter(Mandatory)][string]$Path, [Parameter(Mandatory)][AllowEmptyString()][string]$Text)
    $tmp = $Path + '.tmp'
    $bytes = $script:Utf8.GetBytes($Text)
    $fs = [System.IO.FileStream]::new($tmp, [System.IO.FileMode]::Create, [System.IO.FileAccess]::Write, [System.IO.FileShare]::None)
    try { $fs.Write($bytes, 0, $bytes.Length); $fs.Flush($true) } finally { $fs.Dispose() }
    $sw = [System.Diagnostics.Stopwatch]::StartNew()
    $attempts = 0
    $fail = {
        param($outcome, $err)
        $script:LastReplace = [pscustomobject]@{ Attempts = $attempts; ElapsedMs = [long]$sw.ElapsedMilliseconds; Outcome = $outcome }
        try { if ([System.IO.File]::Exists($tmp)) { [System.IO.File]::Delete($tmp) } } catch { }
        throw $err
    }
    while ($true) {
        $attempts++
        $e = $null
        try { [System.IO.File]::Move($tmp, $Path, $true) } catch { $e = $_.Exception }
        if ($null -eq $e) {
            $script:LastReplace = [pscustomobject]@{ Attempts = $attempts; ElapsedMs = [long]$sw.ElapsedMilliseconds; Outcome = 'replaced' }
            return
        }
        while ($e -is [System.Management.Automation.MethodInvocationException] -and $null -ne $e.InnerException) { $e = $e.InnerException }
        if (-not (Test-TransientReplaceDenial -Exception $e -Target $Path)) { & $fail 'not_retried' $e }
        if ($sw.ElapsedMilliseconds + $script:ReplaceRetryGuardMs -gt $script:ReplaceRetryBudgetMs) { & $fail 'budget_exceeded' $e }
        [System.Threading.Thread]::Sleep([int]$script:ReplaceRetryPollMs)
        if ($sw.ElapsedMilliseconds + $script:ReplaceRetryGuardMs -gt $script:ReplaceRetryBudgetMs) { & $fail 'budget_exceeded' $e }
    }
}
function Write-ReasonFile {
    param([Parameter(Mandatory)][string]$Directory, [Parameter(Mandatory)][string]$Step, [string]$RunId, $Mismatches = @(), [string]$Detail)
    if (-not (Test-Path -LiteralPath $Directory -PathType Container)) { [void][System.IO.Directory]::CreateDirectory($Directory) }
    $o = [ordered]@{ step = $Step; runId = $RunId; status = 'incomplete' }
    $list = @($Mismatches | ForEach-Object { [ordered]@{ where = [string]$_.Where; kind = [string]$_.Kind } })
    if ($list.Count -gt 0) { $o['mismatches'] = $list }
    if ($Detail) { $o['detail'] = $Detail.Substring(0, [Math]::Min(500, $Detail.Length)) }
    Write-TextAtomically -Path (Join-Path $Directory 'REASON.json') -Text ((ConvertTo-CanonicalJson -Value $o) + "`n")
}

# ---------------------------------------------------------------------------------------------------------------------
# Run_Lease (design "Run_Lease", "Lease timing"; R24.7, R24.9). The lease directory is written only by the Launcher.
function New-LeaseNonce {
    $b = [byte[]]::new(16)
    [System.Security.Cryptography.RandomNumberGenerator]::Fill($b)
    [Convert]::ToHexString($b).ToLowerInvariant()
}

function New-RunLease {
    [CmdletBinding()]
    param([Parameter(Mandatory)][string]$LeaseDir, [Parameter(Mandatory)][string]$RunId, [Parameter(Mandatory)][string]$Nonce, [Parameter(Mandatory)]$Settings)
    if (Test-Path -LiteralPath $LeaseDir) { throw "the lease directory already exists: $LeaseDir" }
    [void][System.IO.Directory]::CreateDirectory($LeaseDir)
    $me = Get-Process -Id $PID
    $lease = [ordered]@{
        heartbeat_interval_ms = [long]$Settings.heartbeatIntervalMs
        issued_by = 'launcher'
        launcher_pid = [long]$PID
        launcher_start_ticks = [string]$me.StartTime.ToUniversalTime().Ticks
        nonce_sha256 = Get-Sha256HexOfText -Text $Nonce
        run_id = $RunId
        stale_after_ms = [long]$Settings.staleAfterMs
    }
    Write-TextAtomically -Path (Join-Path $LeaseDir 'lease.json') -Text (ConvertTo-CanonicalJson -Value $lease)
    Write-TextAtomically -Path (Join-Path $LeaseDir 'heartbeat') -Text '1'
    [pscustomobject]@{ Dir = $LeaseDir; Counter = [long]1 }
}

# Increments the counter by 1: temporary file, then rename in the same directory. The counter only increases.
function Step-LeaseHeartbeat {
    param([Parameter(Mandatory)]$Lease)
    $Lease.Counter = [long]$Lease.Counter + 1
    Write-TextAtomically -Path (Join-Path $Lease.Dir 'heartbeat') -Text ([string]$Lease.Counter)
    $Lease.Counter
}

# At the end: `revoked` first, then `heartbeat` is removed. The directory is kept for diagnosis.
function Revoke-RunLease {
    param([Parameter(Mandatory)]$Lease)
    Write-TextAtomically -Path (Join-Path $Lease.Dir 'revoked') -Text 'revoked'
    $hb = Join-Path $Lease.Dir 'heartbeat'
    if (Test-Path -LiteralPath $hb) { [System.IO.File]::Delete($hb) }
}

# ---------------------------------------------------------------------------------------------------------------------
# Recovery (R24.12, C9): only after both locks are held. Stops leftover runtime containers by label and confirms that they are stopped.
function Stop-LeftoverRuntimeContainers {
    $ids = @((Invoke-DockerCli -Arguments @('ps', '-a', '-q', '--filter', 'label=phoenix.discovery.role=runtime')).Output -split "`n" | ForEach-Object { $_.Trim() } | Where-Object { $_ })
    $stopped = [System.Collections.Generic.List[string]]::new()
    foreach ($id in $ids) {
        if (-not (Stop-ContainerConfirmed -Container $id)) { throw "a leftover runtime container could not be stopped: $id" }
        $stopped.Add($id)
    }
    , $stopped.ToArray()
}

function Test-ContainerRunning {
    param([Parameter(Mandatory)][string]$Container)
    $r = Invoke-DockerCli -Arguments @('inspect', '--format', '{{.State.Running}}', $Container)
    if ($r.ExitCode -ne 0) { return $false }   # a container that does not exist is not running
    $r.Output.Trim() -eq 'true'
}

# docker stop, then docker kill if needed, then a confirmation by docker inspect (R24.11).
function Stop-ContainerConfirmed {
    param([Parameter(Mandatory)][string]$Container)
    if (-not (Test-ContainerRunning -Container $Container)) { return $true }
    [void](Invoke-DockerCli -Arguments @('stop', '--time', '10', $Container))
    if (Test-ContainerRunning -Container $Container) { [void](Invoke-DockerCli -Arguments @('kill', $Container)) }
    -not (Test-ContainerRunning -Container $Container)
}

# For every Run_Volume without a verified completed export: a Reason_File `interrupted` in its Incoming_Export (created if needed);
# the volume is kept; no Completion_Marker. A Run that already has a Reason_File keeps it.
# A probe diagnostic volume (label phoenix.discovery.volume-kind=probe-diagnostic) is reported, never removed, and its existing
# Incoming_Export is never written: only when no export directory exists at all is a Reason_File `interrupted` created for it.
function Get-RunVolumes {
    $out = (Invoke-DockerCli -Arguments @('volume', 'ls', '--filter', 'name=phoenix-run-', '--format', '{{.Name}}|{{.Label "phoenix.discovery.volume-kind"}}')).Output
    @($out -split "`n" | ForEach-Object { $_.Trim() } | Where-Object { $_ -cmatch '^phoenix-run-' } | ForEach-Object {
        $parts = $_.Split('|', 2); [pscustomobject]@{ Name = $parts[0]; Kind = $(if ($parts.Count -gt 1) { $parts[1] } else { '' }) } })
}

function Set-InterruptedRuns {
    param([Parameter(Mandatory)][string]$RepoRoot, [System.Collections.Generic.List[string]]$ProbeKept)
    $marked = [System.Collections.Generic.List[string]]::new()
    foreach ($vol in (Get-RunVolumes)) {
        $v = $vol.Name
        $runId = $v.Substring('phoenix-run-'.Length)
        if (-not (Test-SafeRelativePath -Path $runId) -or $runId.Contains('/')) { continue }
        $p = Get-RunPaths -RepoRoot $RepoRoot -RunId $runId
        if ($vol.Kind -ceq 'probe-diagnostic') {
            if ($null -ne $ProbeKept) { $ProbeKept.Add($runId) }
            if (Test-Path -LiteralPath $p.Export) { continue }
        }
        if ((Test-Path -LiteralPath $p.Final -PathType Container) -and (Test-CompletedRun -Path $p.Final)) { continue }
        if (Test-Path -LiteralPath (Join-Path $p.Export 'REASON.json')) { continue }
        $marker = Join-Path $p.Export 'COMPLETE'
        if (Test-Path -LiteralPath $marker) { [System.IO.File]::Delete($marker) }
        Write-ReasonFile -Directory $p.Export -Step 'interrupted' -RunId $runId -Detail 'the Launcher of this Run ended without a verified export; the Run_Volume is kept for diagnosis'
        $marked.Add($runId)
    }
    , $marked.ToArray()
}

# ---------------------------------------------------------------------------------------------------------------------
# The container of a Run or of the probe of task 2.20 (OD-12, decided 2026-11-12: option (a), a Launcher-started toolchain probe).
# The probe is NOT a Run: its Launcher record says `probe`, it writes no Run_Manifest, and it is evidence for no M4 isolation
# requirement. A Run uses the runtime image only; the probe image is refused for a Run, and the runtime image for a probe.
function Get-ContainerName { param([string]$RunId) "phoenix-discovery-$RunId" }

function New-ContainerCreateArgs {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)][ValidateSet('run', 'probe')][string]$Profile,
        [Parameter(Mandatory)][string]$RepoRoot, [Parameter(Mandatory)][string]$RunId, [Parameter(Mandatory)][string]$Nonce,
        [Parameter(Mandatory)][long]$PropagationDelayMs
    )
    $p = Get-RunPaths -RepoRoot $RepoRoot -RunId $RunId
    $repo = [System.IO.Path]::GetFullPath($RepoRoot)
    $a = [System.Collections.Generic.List[string]]::new()
    foreach ($x in @('create', '--name', (Get-ContainerName -RunId $RunId), '--network', $script:LabNetwork, '--read-only', '--cap-drop', 'ALL',
            '--security-opt', 'no-new-privileges:true', '--user', $script:RuntimeUid, '--tmpfs', '/tmp:rw,size=64m', '--memory', '1g', '--cpus', '1',
            '--pids-limit', '256', '--label', 'phoenix.discovery.role=runtime', '--label', "phoenix.discovery.run-id=$RunId",
            '--label', "phoenix.discovery.start=$Profile", '--env', "PHOENIX_RUN_ID=$RunId", '--env', "PHOENIX_LEASE_NONCE=$Nonce",
            '--env', "PHOENIX_LEASE_D_MS=$PropagationDelayMs", '--mount', "type=bind,source=$($p.Lease),target=/run/lease,readonly",
            '--mount', "type=volume,source=$($p.Volume),target=/run/out")) { $a.Add($x) }
    if ($Profile -eq 'probe') {
        foreach ($x in @('--mount', "type=bind,source=$(Join-Path $repo 'packages'),target=/workspace/packages,readonly",
                '--mount', "type=volume,source=$script:NodeModulesVolume,target=/workspace/node_modules,readonly",
                '--workdir', '/workspace', $script:ProbeImage, 'node', '/workspace/packages/verifier/dist/probe/main.js')) { $a.Add($x) }
    } else {
        # Wired to the runtime image in task 4.9 (the image and its entry point do not exist before that task).
        foreach ($rel in @('legacy/src/index.php', 'legacy/src/db.php', 'legacy/src/products.php', 'legacy/src/orders.php', 'legacy/src/utils.php', 'legacy/sql/schema.sql', 'legacy/sql/seed.sql', 'docs/ai-input-allowlist.json', 'docs/ai-input-allowlist.md')) {
            $a.Add('--mount'); $a.Add("type=bind,source=$(Join-Path $repo $rel),target=/repo/$rel,readonly")
        }
        $a.Add('--mount'); $a.Add("type=bind,source=$(Join-Path $repo 'discovery/config/run-config.json'),target=/run/config/run-config.json,readonly")
        $a.Add('--mount'); $a.Add("type=bind,source=$(Join-Path $repo 'discovery/config/audit-config.json'),target=/run/config/audit-config.json,readonly")
        $a.Add('--env'); $a.Add('HOME=/nonexistent')
        $a.Add($script:RuntimeImage)
    }
    , $a.ToArray()
}

# The mounts a created container may have: exactly the ones of its profile (design: "Mounts (the complete list)").
function Get-ExpectedMountTargets {
    param([ValidateSet('run', 'probe')][string]$Profile)
    if ($Profile -eq 'probe') { return , @('/run/lease', '/run/out', '/workspace/node_modules', '/workspace/packages') }
    $t = @('/run/lease', '/run/out', '/run/config/audit-config.json', '/run/config/run-config.json', '/repo/docs/ai-input-allowlist.json', '/repo/docs/ai-input-allowlist.md')
    $t += @('/repo/legacy/src/index.php', '/repo/legacy/src/db.php', '/repo/legacy/src/products.php', '/repo/legacy/src/orders.php', '/repo/legacy/src/utils.php', '/repo/legacy/sql/schema.sql', '/repo/legacy/sql/seed.sql')
    , @($t | Sort-Object)
}

# mount_inspection: the mounts and the networks of the created container against the profile. Written as the attestation into the
# lease directory before the container starts (R15.12). A mismatch refuses the start.
function Get-MountInspection {
    param([Parameter(Mandatory)][string]$Container, [Parameter(Mandatory)][string]$Profile)
    $r = Invoke-DockerCli -Arguments @('inspect', '--format', '{{json .Mounts}}|{{json .NetworkSettings.Networks}}|{{json .HostConfig.PortBindings}}|{{.HostConfig.Privileged}}', $Container)
    if ($r.ExitCode -ne 0) { return [pscustomobject]@{ Ok = $false; Problems = @('inspect_failed'); Attestation = $null } }
    $parts = $r.Output.Trim().Split('|')
    $problems = [System.Collections.Generic.List[string]]::new()
    $mounts = @(); $networks = @(); $ports = $null; $privileged = 'unknown'
    try {
        $parsedMounts = ConvertFrom-JsonStrict -Text $parts[0]
        $mounts = @($parsedMounts)
        $netObj = ConvertFrom-JsonStrict -Text $parts[1]
        $networks = @($netObj.Keys | ForEach-Object { [string]$_ } | Sort-Object)
        $ports = ConvertFrom-JsonStrict -Text $parts[2]
        $privileged = $parts[3]
    } catch { $problems.Add('inspect_unparsable') }
    $targets = @($mounts | ForEach-Object { [string]$_['Destination'] } | Sort-Object)
    if (($targets -join ',') -cne ((Get-ExpectedMountTargets -Profile $Profile) -join ',')) { $problems.Add('mounts_differ') }
    if (@($mounts | Where-Object { $_['Destination'] -cne '/run/out' -and $_['RW'] -eq $true }).Count -gt 0) { $problems.Add('writable_mount') }
    if (@($mounts | Where-Object { [string]$_['Source'] -match 'docker\.sock' }).Count -gt 0) { $problems.Add('docker_socket') }
    if (($networks -join ',') -cne $script:LabNetwork) { $problems.Add('networks_differ') }
    if ($null -ne $ports -and $ports -is [System.Collections.IDictionary] -and $ports.Count -gt 0) { $problems.Add('published_port') }
    if ($privileged -ne 'false') { $problems.Add('privileged') }
    $att = [ordered]@{ check = 'mount_inspection'; container = $Container; profile = $Profile; mounts = @($targets); networks = @($networks); ok = ($problems.Count -eq 0); problems = @($problems) }
    [pscustomobject]@{ Ok = ($problems.Count -eq 0); Problems = $problems.ToArray(); Attestation = $att }
}

# ---------------------------------------------------------------------------------------------------------------------
# The start gate (no side effect). Approval: the latest override-apply record is approved and the store verifies (R18.20; a backstop,
# not a replacement for the procedure). Lease timing: a valid measurement record for these settings and this Docker server version.
function Test-LaunchGate {
    [CmdletBinding()]
    param([Parameter(Mandatory)][string]$RepoRoot, [Parameter(Mandatory)][ValidateSet('run', 'probe')][string]$Profile, [string]$ApprovalStorePath, [string]$LeaseTimingPath)
    if (-not $ApprovalStorePath) { $ApprovalStorePath = Join-Path $RepoRoot 'discovery/approvals/approvals.jsonl' }
    if (-not $LeaseTimingPath) { $LeaseTimingPath = Join-Path $RepoRoot 'discovery/config/lease-timing.json' }
    $refuse = { param($code, $detail) [pscustomobject]@{ Ok = $false; Code = $code; Detail = $detail; Timing = $null; ImageDigest = $null; Gate = $null } }
    $gate = Get-ApprovalGateStatus -StorePath $ApprovalStorePath -GateId 'override-apply'
    if ($gate.Status -ne 'approved') { return (& $refuse 'override_apply_not_approved' "gate status: $($gate.Status); $($gate.Error)") }
    $server = (Invoke-DockerCli -Arguments @('version', '--format', '{{.Server.Version}}')).Output.Trim()
    $settings = Get-LeaseSettings
    $timing = Test-LeaseTimingRecord -Path $LeaseTimingPath -Settings $settings -DockerServerVersion $server
    if (-not $timing.Ok) { return (& $refuse $timing.Code ($timing.Problems -join ',')) }
    $image = if ($Profile -eq 'probe') { $script:ProbeImage } else { $script:RuntimeImage }
    $img = Invoke-DockerCli -Arguments @('image', 'inspect', '--format', '{{.Id}}', $image)
    if ($img.ExitCode -ne 0 -or $img.Output.Trim() -cnotmatch '^sha256:[0-9a-f]{64}$') { return (& $refuse $(if ($Profile -eq 'probe') { 'probe_image_missing' } else { 'runtime_image_missing' }) $image) }
    [pscustomobject]@{ Ok = $true; Code = $null; Detail = $null; Timing = $timing; ImageDigest = $img.Output.Trim(); Gate = $gate }
}

# ---------------------------------------------------------------------------------------------------------------------
# The Run_Volume owner helper (design: the ownership step is UNVERIFIED on Docker Desktop, OD-3). The privileges are those of the
# existing design and are not widened: uid 0 with only CAP_CHOWN (all other capabilities dropped), no new privileges, no network,
# read-only root, small limits, and only the new volume mounted. It changes the owner of the volume root only (not recursive) and
# then checks the result. Any non-zero exit code is a failure; the caller stops before the lease and the container.
function Invoke-VolumeOwnerHelper {
    param([Parameter(Mandatory)][string]$Volume)
    $cmd = "chown $script:RuntimeUid /v && test `"`$(stat -c %u:%g /v)`" = `"$script:RuntimeUid`""
    $r = Invoke-DockerCli -Arguments @('run', '--rm', '--network', 'none', '--read-only', '--cap-drop', 'ALL', '--cap-add', 'CHOWN', '--security-opt', 'no-new-privileges:true',
        '--memory', '64m', '--cpus', '0.5', '--pids-limit', '16', '--user', '0:0', '--label', 'phoenix.discovery.role=volume-owner',
        '--mount', "type=volume,source=$Volume,target=/v", $script:HelperImage, 'sh', '-c', $cmd)
    $detail = if ($r.ExitCode -eq 0) { $null } else { ("owner helper exit code $($r.ExitCode): " + ([string]$r.Error).Trim()).Trim() }
    [pscustomobject]@{ Ok = ($r.ExitCode -eq 0); ExitCode = $r.ExitCode; Detail = $detail }
}

function Get-VolumeKind { param([ValidateSet('run', 'probe')][string]$Profile) if ($Profile -eq 'probe') { 'probe-diagnostic' } else { 'run' } }

# Export procedure (task 2.21; design steps 2 to 9). Called after the container is stopped and the lease is revoked. The Run lock is
# held by the caller. Returns Outcome (complete | incomplete), Step (of a failure), Disposition, Location.
function Invoke-RunExport {
    [CmdletBinding()]
    param([Parameter(Mandatory)][string]$RepoRoot, [Parameter(Mandatory)][string]$RunId, [ValidateSet('run', 'probe')][string]$Profile = 'run')
    $p = Get-RunPaths -RepoRoot $RepoRoot -RunId $RunId
    $fail = {
        param($step, $dir, $mismatches, $detail)
        foreach ($d in @($p.Export, $p.Final)) { $m = Join-Path $d 'COMPLETE'; if (Test-Path -LiteralPath $m) { try { [System.IO.File]::Delete($m) } catch { } } }
        $reasonDir = if ($dir) { $dir } else { $p.Export }
        try { Write-ReasonFile -Directory $reasonDir -Step $step -RunId $RunId -Mismatches $mismatches -Detail $detail } catch { }
        [pscustomobject]@{ Outcome = 'incomplete'; Step = $step; Disposition = 'kept_for_diagnosis'; Location = $reasonDir }
    }
    # 2. create the export directory only now (R12.18); fail if it exists (R12.2)
    if (Test-Path -LiteralPath $p.Export) { return (& $fail 'create_export' (Join-Path $p.Incoming "$RunId.collision") @() 'the Incoming_Export already exists; it is left unchanged') }
    try { if (-not (Test-Path -LiteralPath $p.Incoming)) { [void][System.IO.Directory]::CreateDirectory($p.Incoming) }; [void][System.IO.Directory]::CreateDirectory($p.Export) }
    catch { return (& $fail 'create_export' $null @() $_.Exception.Message) }
    # 3. copy with a short-lived helper container: no network, read-only, non-root, no capability, the volume read-only, only the export writable
    $copy = Invoke-DockerCli -Arguments @('run', '--rm', '--network', 'none', '--read-only', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges:true',
        '--user', $script:RuntimeUid, '--label', 'phoenix.discovery.role=export-helper', '--mount', "type=volume,source=$($p.Volume),target=/src,readonly",
        '--mount', "type=bind,source=$($p.Export),target=/dst", $script:HelperImage, 'sh', '-c', 'cp -R /src/. /dst/')
    if ($copy.ExitCode -ne 0) { return (& $fail 'copy' $null @() "helper exit code $($copy.ExitCode)") }
    # 4. verify on the host (read-only)
    $v = Test-RunDirectory -Path $p.Export
    if ($v.Incomplete -or $v.Result -ne 'success') { return (& $fail 'verify' $null $v.Mismatches $(if ($v.Incomplete) { "incomplete: $($v.IncompleteReason)" } else { 'verification failed' })) }
    # 5. the Completion_Marker last
    try { Write-TextAtomically -Path (Join-Path $p.Export 'COMPLETE') -Text $v.ManifestSha256 }
    catch { return (& $fail 'marker' $null @() $_.Exception.Message) }
    # 6. move (convenience only; atomicity is not assumed)
    try { [System.IO.Directory]::Move($p.Export, $p.Final) }
    catch { return (& $fail 'move' $(if (Test-Path -LiteralPath $p.Final) { $p.Final } else { $p.Export }) @() $_.Exception.Message) }
    # 7. verify the final location again and check the marker
    if (-not (Test-CompletedRun -Path $p.Final)) {
        $again = Test-RunDirectory -Path $p.Final -RequireMarker
        return (& $fail 'final_verify' $p.Final $again.Mismatches 'the final location does not verify')
    }
    # 8. remove the volume only now; a probe diagnostic volume is never removed by the Launcher (a human removes it, with approval)
    if ($Profile -eq 'probe') { return [pscustomobject]@{ Outcome = 'complete'; Step = $null; Disposition = 'probe_diagnostic_kept'; Location = $p.Final } }
    $rm = Invoke-DockerCli -Arguments @('volume', 'rm', $p.Volume)
    [pscustomobject]@{ Outcome = 'complete'; Step = $null; Disposition = $(if ($rm.ExitCode -eq 0) { 'removed_after_verified_export' } else { 'kept_for_diagnosis' }); Location = $p.Final }
}

function Write-LauncherRecord {
    param([Parameter(Mandatory)][string]$RepoRoot, [Parameter(Mandatory)][string]$RunId, [Parameter(Mandatory)]$Record, [Parameter(Mandatory)][string]$Outcome)
    $p = Get-RunPaths -RepoRoot $RepoRoot -RunId $RunId
    $dir = if ($Outcome -eq 'complete') { $p.Runs } else { $p.Incoming }
    if (-not (Test-Path -LiteralPath $dir)) { [void][System.IO.Directory]::CreateDirectory($dir) }
    $path = Join-Path $dir "$RunId.launcher.json"
    Write-TextAtomically -Path $path -Text ((ConvertTo-CanonicalJson -Value $Record) + "`n")
    $path
}

# ---------------------------------------------------------------------------------------------------------------------
# The heartbeat loop while the container runs: one beat at most every H, scheduled from the previous beat so that delays do not
# accumulate; beats later than H + J are counted. Returns when the container is no longer running or the Run time is exceeded.
function Wait-RuntimeContainer {
    param([Parameter(Mandatory)][string]$Container, [Parameter(Mandatory)]$Lease, [Parameter(Mandatory)]$Settings, [long]$MaxRunMs = ($script:MaxRunSeconds * 1000))
    $h = [long]$Settings.heartbeatIntervalMs
    $j = [long]((Get-LeaseTimingSettings -Settings $Settings).jitterMs)
    $start = & $script:NowMs
    $last = $start
    $next = $start + $h
    $late = 0; $beats = 0
    while ($true) {
        $now = & $script:NowMs
        if ($now -lt $next) { & $script:SleepMs ($next - $now); $now = & $script:NowMs }
        [void](Step-LeaseHeartbeat -Lease $Lease); $beats++
        if ($now - $last -gt $h + $j) { $late++ }
        $last = $now
        $next = $next + $h
        if (-not (Test-ContainerRunning -Container $Container)) { return [pscustomobject]@{ Ended = 'container_stopped'; Beats = $beats; LateBeats = $late } }
        if ($now - $start -gt $MaxRunMs) { return [pscustomobject]@{ Ended = 'run_time_exceeded'; Beats = $beats; LateBeats = $late } }
    }
}

# ---------------------------------------------------------------------------------------------------------------------
# A one-dimensional list for the Launcher record (never a list inside a list).
function ConvertTo-FlatList { param($Value) $out = [System.Collections.Generic.List[object]]::new(); foreach ($x in @($Value)) { foreach ($y in @($x)) { if ($null -ne $y) { $out.Add($y) } } }; , $out.ToArray() }

# The evidence of the end is saved when the Launcher record was written and the export got past the copy step (the export directory
# holds the copied files, with a Completion_Marker or a Reason_File). A failed creation of the export, or a failed copy, is not saved.
function Test-EvidenceSaved {
    param($Export, [string]$RecordPath)
    if (-not $RecordPath -or -not (Test-Path -LiteralPath $RecordPath -PathType Leaf)) { return $false }
    if ($null -eq $Export) { return $false }
    if ($Export.Outcome -eq 'complete') { return (Test-Path -LiteralPath $Export.Location -PathType Container) }
    if ($Export.Step -in @('create_export', 'copy')) { return $false }
    Test-Path -LiteralPath (Join-Path $Export.Location 'REASON.json') -PathType Leaf
}

# Removes this Run's own container, by the ID returned at creation, and only when it is confirmed to be that container (same ID, the
# Run identifier label, the runtime role label) and not running. Never --force, never -v (no volume is removed). Idempotent: a container
# that no longer exists is 'absent'. Every other case is 'kept' with the reason, and is reported as a remaining resource.
function Remove-OwnRunContainer {
    param([string]$ContainerId, [string]$RunId, [bool]$StopConfirmed, [bool]$EvidenceSaved)
    $kept = { param($reason) [pscustomobject]@{ Outcome = 'kept'; Reason = $reason } }
    if (-not $StopConfirmed) { return (& $kept 'stop_not_confirmed') }
    if (-not $EvidenceSaved) { return (& $kept 'evidence_not_saved') }
    if (-not $ContainerId -or $ContainerId -cnotmatch '^[0-9A-Za-z_.-]+$') { return (& $kept 'identity_unknown') }
    $r = Invoke-DockerCli -Arguments @('inspect', '--format', '{{.Id}}|{{index .Config.Labels "phoenix.discovery.run-id"}}|{{index .Config.Labels "phoenix.discovery.role"}}|{{.State.Running}}', $ContainerId)
    if ($r.ExitCode -ne 0) {
        if (([string]$r.Error + [string]$r.Output) -match '(?i)no such') { return [pscustomobject]@{ Outcome = 'absent'; Reason = 'already_removed' } }
        return (& $kept 'inspect_failed')
    }
    $f = $r.Output.Trim().Split('|')
    if ($f.Count -ne 4 -or $f[0] -cne $ContainerId -or $f[1] -cne $RunId -or $f[2] -cne 'runtime') { return (& $kept 'identity_mismatch') }
    if ($f[3] -ne 'false') { return (& $kept 'still_running') }
    $rm = Invoke-DockerCli -Arguments @('rm', $ContainerId)
    if ($rm.ExitCode -ne 0) { return (& $kept "rm_failed") }
    [pscustomobject]@{ Outcome = 'removed'; Reason = $null }
}

# ---------------------------------------------------------------------------------------------------------------------
# One start, from the gate to the release of the Run lock. Exit codes: 0 complete (or probe ended), 1 incomplete or error end,
# 2 refused before any side effect (a lock, the gate, the timing record), 3 refused after the locks (collision, recovery, inspection).
function Invoke-DiscoveryStart {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)][string]$RepoRoot,
        [Parameter(Mandatory)][ValidateSet('run', 'probe')][string]$Profile,
        [Parameter(Mandatory)][string]$MutexName,
        [Parameter(Mandatory)][string]$LockPath,
        [string]$ApprovalStorePath,
        [string]$LeaseTimingPath,
        [scriptblock]$Log = { param($m) Write-Host $m }
    )
    & $Log $script:ScopeNote
    $result = { param($exit, $code, $extra = @{}) $o = [ordered]@{ ExitCode = $exit; Code = $code }; foreach ($k in $extra.Keys) { $o[$k] = $extra[$k] }; [pscustomobject]$o }

    $gate = Test-LaunchGate -RepoRoot $RepoRoot -Profile $Profile -ApprovalStorePath $ApprovalStorePath -LeaseTimingPath $LeaseTimingPath
    if (-not $gate.Ok) { & $Log "refused: $($gate.Code) ($($gate.Detail))"; return (& $result 2 $gate.Code) }

    $locks = Enter-DiscoveryLocks -MutexName $MutexName -LockPath $LockPath
    if (-not $locks.Ok) { & $Log "refused: $($locks.Code)"; return (& $result 2 $locks.Code) }

    $runId = $null; $lease = $null; $container = $null; $containerId = $null; $exportResult = $null; $stopConfirmed = $false; $wait = $null; $endCode = $null
    $record = [ordered]@{ kind = 'launcher-record'; schemaVersion = [long]1; profile = $Profile; scope = $script:ScopeNote }
    try {
        # Recovery first, holding both locks (R24.12, C9).
        try {
            # Both functions return their list with the unary comma; assigning first and flattening keeps the record one-dimensional.
            $stoppedLeftovers = Stop-LeftoverRuntimeContainers
            $record['leftoverContainersStopped'] = ConvertTo-FlatList $stoppedLeftovers
            $probeKept = [System.Collections.Generic.List[string]]::new()
            $markedRuns = Set-InterruptedRuns -RepoRoot $RepoRoot -ProbeKept $probeKept
            $record['interruptedRunsMarked'] = ConvertTo-FlatList $markedRuns
            $record['probeDiagnosticVolumesKept'] = @($probeKept)
        } catch { & $Log "refused: recovery_failed ($($_.Exception.Message))"; return (& $result 3 'recovery_failed') }

        $runId = New-DiscoveryRunId
        $free = Test-RunIdFree -RepoRoot $RepoRoot -RunId $runId
        if (-not $free.Free) { & $Log "refused: run_id_collision ($($free.Taken -join ','))"; return (& $result 3 'run_id_collision' @{ RunId = $runId }) }
        $p = Get-RunPaths -RepoRoot $RepoRoot -RunId $runId
        $record['runId'] = $runId
        $record['imageDigest'] = $gate.ImageDigest
        $record['start'] = $Profile
        $record['leaseTimingRecordSha256'] = $gate.Timing.RecordSha256
        $record['leaseTimingStatement'] = Get-LeaseTimingStatement

        # The Run_Volume, empty, with the runtime owner (the ownership step is UNVERIFIED on Docker Desktop, OD-3).
        # The volume kind tells a normal Run from a probe: a probe volume is a diagnostic volume that no tool removes (task 2.20).
        $volumeKind = Get-VolumeKind -Profile $Profile
        $record['volumeKind'] = $volumeKind
        if ((Invoke-DockerCli -Arguments @('volume', 'create', '--label', 'phoenix.discovery.role=run-volume', '--label', "phoenix.discovery.run-id=$runId",
                '--label', "phoenix.discovery.start=$Profile", '--label', "phoenix.discovery.volume-kind=$volumeKind", $p.Volume)).ExitCode -ne 0) {
            & $Log 'refused: volume_create_failed'; return (& $result 3 'volume_create_failed' @{ RunId = $runId })
        }
        $owner = Invoke-VolumeOwnerHelper -Volume $p.Volume
        $record['volumeOwner'] = [ordered]@{ exitCode = [long]$owner.ExitCode; ok = [bool]$owner.Ok }
        if (-not $owner.Ok) {
            # Stop before the lease and the container. The empty volume is kept (its removal needs a human); the cause goes into a
            # Reason_File in the Incoming_Export, so the recovery of the next start does not overwrite it, and into the Launcher record.
            $endCode = 'volume_owner_failed'
            $record['volumeOwner']['detail'] = $owner.Detail
            $record['volumeDisposition'] = 'kept_for_diagnosis'
            try { Write-ReasonFile -Directory $p.Export -Step 'volume_owner' -RunId $runId -Detail $owner.Detail } catch { }
            try { [void](Write-LauncherRecord -RepoRoot $RepoRoot -RunId $runId -Record $record -Outcome 'incomplete') } catch { }
            & $Log "refused: volume_owner_failed ($($owner.Detail))"
            return (& $result 3 $endCode @{ RunId = $runId })
        }

        $nonce = New-LeaseNonce
        $settings = Get-LeaseSettings
        $lease = New-RunLease -LeaseDir $p.Lease -RunId $runId -Nonce $nonce -Settings $settings
        $record['lease'] = [ordered]@{ nonceSha256 = Get-Sha256HexOfText -Text $nonce; launcherPid = [long]$PID; heartbeatIntervalMs = [long]$settings.heartbeatIntervalMs; staleAfterMs = [long]$settings.staleAfterMs }

        $container = Get-ContainerName -RunId $runId
        $create = Invoke-DockerCli -Arguments (New-ContainerCreateArgs -Profile $Profile -RepoRoot $RepoRoot -RunId $runId -Nonce $nonce -PropagationDelayMs ([long]$gate.Timing.D))
        if ($create.ExitCode -ne 0) { $endCode = 'container_create_failed'; return (& $result 3 $endCode @{ RunId = $runId }) }
        $containerId = $create.Output.Trim()
        $record['containerId'] = $containerId
        $inspection = Get-MountInspection -Container $container -Profile $Profile
        Write-TextAtomically -Path (Join-Path $p.Lease 'isolation-attestation.json') -Text ((ConvertTo-CanonicalJson -Value $inspection.Attestation) + "`n")
        if (-not $inspection.Ok) { $endCode = 'mount_inspection_failed'; & $Log "refused: mount_inspection_failed ($($inspection.Problems -join ','))"; return (& $result 3 $endCode @{ RunId = $runId }) }

        if ((Invoke-DockerCli -Arguments @('start', $container)).ExitCode -ne 0) { $endCode = 'container_start_failed'; return (& $result 1 $endCode @{ RunId = $runId }) }
        $wait = Wait-RuntimeContainer -Container $container -Lease $lease -Settings $settings
        $record['heartbeats'] = [long]$wait.Beats
        $record['lateHeartbeats'] = [long]$wait.LateBeats
        $record['ended'] = $wait.Ended
        $exitCode = (Invoke-DockerCli -Arguments @('inspect', '--format', '{{.State.ExitCode}}', $container)).Output.Trim()
        $record['containerExitCode'] = $exitCode
        $endCode = if ($wait.Ended -eq 'container_stopped' -and $exitCode -eq '0') { 'ended' } else { 'error_end' }
    } finally {
        # Normal or error end (R24.11), in this order (2026-11-14): (1) the container has ended; (2) stop and confirm, revoke the lease;
        # (3) export and check that the evidence is saved; (4) write the Launcher record (the diagnostic record); (5) remove this Run's own
        # container only, and only if the stop is confirmed, the evidence is saved, the record is written, and its identity is confirmed;
        # (6) the volume is never removed here (the export decides; a probe volume is kept); (7) release the conformance mutex and the
        # Run lock. A container that is not confirmed stopped keeps both held until this process ends.
        if ($null -ne $container) { $stopConfirmed = Stop-ContainerConfirmed -Container $container; $record['containerStopConfirmed'] = $stopConfirmed }
        if ($null -ne $lease) { try { Revoke-RunLease -Lease $lease } catch { } }
        $recordPath = $null; $recordOutcome = $null
        try {
            if ($null -ne $lease -and $null -ne $container -and $stopConfirmed) {
                $exportResult = Invoke-RunExport -RepoRoot $RepoRoot -RunId $runId -Profile $Profile
                $record['export'] = [ordered]@{ outcome = $exportResult.Outcome; step = $exportResult.Step }
                $record['volumeDisposition'] = $exportResult.Disposition
                if ($Profile -eq 'probe') { $record['volumeRemoval'] = 'requires_human_approval' }
                $recordOutcome = $exportResult.Outcome
            } elseif ($null -ne $runId -and $null -ne $lease) {
                $record['volumeDisposition'] = 'kept_for_diagnosis'
                $recordOutcome = 'incomplete'
            }
            if ($null -ne $recordOutcome) {
                if ($null -ne $container) { $record['containerRemoval'] = [ordered]@{ outcome = 'pending' } }
                $recordPath = Write-LauncherRecord -RepoRoot $RepoRoot -RunId $runId -Record $record -Outcome $recordOutcome
            }
        } catch { & $Log "error: the export or the Launcher record failed: $($_.Exception.Message)" }
        try {
            if ($null -ne $container) {
                $saved = Test-EvidenceSaved -Export $exportResult -RecordPath $recordPath
                $removal = Remove-OwnRunContainer -ContainerId $containerId -RunId $runId -StopConfirmed $stopConfirmed -EvidenceSaved $saved
                $record['containerRemoval'] = [ordered]@{ outcome = $removal.Outcome; reason = $removal.Reason }
                if ($removal.Outcome -eq 'kept') { & $Log "warning: container kept ($($removal.Reason)): $container" }
                if ($null -ne $recordPath) { Write-TextAtomically -Path $recordPath -Text ((ConvertTo-CanonicalJson -Value $record) + "`n") }
            }
        } catch { & $Log "error: the container removal step failed: $($_.Exception.Message)" }
        finally {
            if ($null -eq $container -or $stopConfirmed) { Exit-ConformanceMutex -Locks $locks; Exit-RunLock -Locks $locks }
            else { & $Log 'error: the container is not confirmed stopped; the conformance mutex and the Run lock are released only when this process ends' }
        }
    }
    if ($null -ne $exportResult -and $exportResult.Outcome -eq 'complete' -and $endCode -eq 'ended') { return (& $result 0 'complete' @{ RunId = $runId; Export = $exportResult }) }
    & $result 1 $(if ($endCode) { $endCode } else { 'incomplete' }) @{ RunId = $runId; Export = $exportResult }
}

Export-ModuleMember -Function Get-LauncherConstants, Invoke-DockerCli, Set-DockerCliInvoker, Set-LauncherTimeHooks, Enter-RunLock, Enter-DiscoveryLocks, Exit-ConformanceMutex, Exit-RunLock, New-DiscoveryRunId, Test-RunIdFormat, Get-RunPaths, Test-RunIdFree, Write-TextAtomically, Get-AtomicReplaceSettings, Get-LastAtomicReplace, Test-TransientReplaceDenial, Write-ReasonFile, New-LeaseNonce, New-RunLease, Step-LeaseHeartbeat, Revoke-RunLease, Stop-LeftoverRuntimeContainers, Test-ContainerRunning, Stop-ContainerConfirmed, Set-InterruptedRuns, Get-ContainerName, New-ContainerCreateArgs, Get-ExpectedMountTargets, Get-MountInspection, Test-LaunchGate, Invoke-RunExport, Invoke-VolumeOwnerHelper, Get-VolumeKind, Get-RunVolumes, Write-LauncherRecord, Wait-RuntimeContainer, ConvertTo-FlatList, Test-EvidenceSaved, Remove-OwnRunContainer, Invoke-DiscoveryStart