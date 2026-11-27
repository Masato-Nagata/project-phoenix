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
Import-Module (Join-Path $PSScriptRoot 'InputFileGuard.psm1') -DisableNameChecking
Import-Module (Join-Path $PSScriptRoot 'RuntimeReport.psm1') -DisableNameChecking

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
$script:MaxRunSeconds = 1800 + 120   # the default total Run time limit (R11.10) plus the abort and seal time; the limit of a probe, and the default of Wait-RuntimeContainer
# (task 4.9-B1) A Run takes its Launcher limit from the validated limits.runSeconds of run-config.json: runSeconds + LauncherRunMarginSeconds.
$script:RunSecondsDefault = 1800     # limits.runSeconds when the key is absent (limits.ts RUN_LIMITS.runSeconds.default)
$script:RunSecondsMin = 1
$script:RunSecondsMax = 3600
$script:LauncherRunMarginSeconds = 120

function Get-LauncherConstants {
    [pscustomobject]@{
        ConformanceMutexName = $script:ConformanceMutexName; RunLockRelativePath = $script:RunLockRelativePath; ScopeNote = $script:ScopeNote
        RuntimeImage = $script:RuntimeImage; ProbeImage = $script:ProbeImage; HelperImage = $script:HelperImage; LabNetwork = $script:LabNetwork
    }
}

# ---------------------------------------------------------------------------------------------------------------------
# The one Docker entry point.
# Without a capture specification the invocation is the original one (both streams read to the end as text). With one (task 4.9-C2, D5),
# the call goes through Invoke-BoundedProcess: both streams are read as raw bytes with a byte limit and a time limit.
$script:DockerInvoker = {
    param([string[]]$Arguments, $Capture)
    if ($null -ne $Capture) { return (Invoke-BoundedProcess -FileName 'docker' -Arguments $Arguments -LimitBytes ([int]$Capture.LimitBytes) -TimeoutMs ([int]$Capture.TimeoutMs)) }
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

# ---------------------------------------------------------------------------------------------------------------------
# Bounded capture of a child process (task 4.9-C2, D5). Standard output and standard error are read INDEPENDENTLY, each by its own task, as
# raw bytes (no decoding, so nothing is replaced). Each stream keeps at most LimitBytes + 1 bytes: the moment a stream passes LimitBytes, the
# process tree is killed (the limit works while reading, not after). A process that is still running after TimeoutMs is killed too. After a
# kill the process is waited for (at most 10 s), both reading tasks are waited for (at most 10 s; then the streams are closed to unblock
# them), the streams are disposed, and the process object is disposed. The bytes are returned only when both reading tasks ended. Exceeded
# and timed-out results are flagged; their partial bytes are never a complete capture. Nothing here decodes, logs, or throws the bytes.
$script:BoundedSource = @'
using System;
using System.Diagnostics;
using System.IO;
using System.Threading;
using System.Threading.Tasks;

namespace Phoenix.Launcher
{
    public sealed class BoundedResult
    {
        public int ExitCode = -1;
        public byte[] Stdout = new byte[0];
        public byte[] Stderr = new byte[0];
        public bool StdoutExceeded;
        public bool StderrExceeded;
        public bool TimedOut;
        public bool Killed;
        public bool Exited;
        public bool StreamsDrained;
        public bool Started;
        public int ProcessId;
    }

    public static class BoundedProcess
    {
        sealed class Flags { public int Killed; }

        static void Kill(Process p, Flags f)
        {
            try { if (!p.HasExited) { p.Kill(true); Interlocked.Exchange(ref f.Killed, 1); } } catch (Exception) { }
        }

        // Reads until end of stream; true when more than `limit` bytes arrived (then at most limit + 1 bytes are kept).
        static bool Pump(Stream s, MemoryStream into, int limit)
        {
            byte[] buf = new byte[4096];
            while (true)
            {
                int n;
                try { n = s.Read(buf, 0, buf.Length); } catch (Exception) { return false; }
                if (n <= 0) { return false; }
                int room = (int)Math.Max(0L, (long)limit + 1L - into.Length);
                into.Write(buf, 0, Math.Min(n, room));
                if (into.Length > limit) { return true; }
            }
        }

        public static BoundedResult Run(string fileName, string[] arguments, int limit, int timeoutMs)
        {
            BoundedResult r = new BoundedResult();
            if (limit < 1 || timeoutMs < 1 || string.IsNullOrEmpty(fileName)) { return r; }
            ProcessStartInfo psi = new ProcessStartInfo(fileName);
            foreach (string a in arguments) { psi.ArgumentList.Add(a); }
            psi.RedirectStandardOutput = true;
            psi.RedirectStandardError = true;
            psi.RedirectStandardInput = true;
            psi.UseShellExecute = false;
            psi.CreateNoWindow = true;
            Flags flags = new Flags();
            using (Process p = new Process())
            {
                p.StartInfo = psi;
                try { if (!p.Start()) { return r; } } catch (Exception) { return r; }
                r.Started = true;
                try { r.ProcessId = p.Id; } catch (Exception) { }
                try { p.StandardInput.Close(); } catch (Exception) { }
                Stream outS = p.StandardOutput.BaseStream;
                Stream errS = p.StandardError.BaseStream;
                MemoryStream outM = new MemoryStream();
                MemoryStream errM = new MemoryStream();
                int outEx = 0, errEx = 0;
                Task tOut = Task.Run(() => { if (Pump(outS, outM, limit)) { Interlocked.Exchange(ref outEx, 1); Kill(p, flags); } });
                Task tErr = Task.Run(() => { if (Pump(errS, errM, limit)) { Interlocked.Exchange(ref errEx, 1); Kill(p, flags); } });
                bool exited = false;
                try { exited = p.WaitForExit(timeoutMs); } catch (Exception) { exited = false; }
                if (!exited) { r.TimedOut = true; Kill(p, flags); }
                bool gone = false;
                try { gone = p.WaitForExit(10000); } catch (Exception) { gone = false; }
                bool drained = false;
                try { drained = Task.WaitAll(new Task[] { tOut, tErr }, 10000); } catch (Exception) { drained = false; }
                try { outS.Dispose(); } catch (Exception) { }
                try { errS.Dispose(); } catch (Exception) { }
                if (!drained) { try { Task.WaitAll(new Task[] { tOut, tErr }, 2000); } catch (Exception) { } }
                r.StreamsDrained = drained;
                r.Exited = gone;
                if (gone) { try { r.ExitCode = p.ExitCode; } catch (Exception) { r.ExitCode = -1; } }
                r.StdoutExceeded = outEx == 1;
                r.StderrExceeded = errEx == 1;
                r.Killed = flags.Killed == 1;
                if (drained) { r.Stdout = outM.ToArray(); r.Stderr = errM.ToArray(); }
            }
            return r;
        }
    }
}
'@

function Invoke-BoundedProcess {
    [CmdletBinding()]
    param([Parameter(Mandatory)][string]$FileName, [Parameter(Mandatory)][AllowEmptyCollection()][string[]]$Arguments, [Parameter(Mandatory)][int]$LimitBytes, [Parameter(Mandatory)][int]$TimeoutMs)
    if (-not ('Phoenix.Launcher.BoundedProcess' -as [type])) { Add-Type -TypeDefinition $script:BoundedSource -Language CSharp -ErrorAction Stop }
    $r = [Phoenix.Launcher.BoundedProcess]::Run($FileName, $Arguments, $LimitBytes, $TimeoutMs)
    [pscustomobject]@{
        ExitCode = [int]$r.ExitCode; Stdout = [byte[]]$r.Stdout; Stderr = [byte[]]$r.Stderr; StdoutExceeded = [bool]$r.StdoutExceeded; StderrExceeded = [bool]$r.StderrExceeded
        TimedOut = [bool]$r.TimedOut; Killed = [bool]$r.Killed; Exited = [bool]$r.Exited; StreamsDrained = [bool]$r.StreamsDrained; Started = [bool]$r.Started; ProcessId = [int]$r.ProcessId
    }
}

# A Docker call with a bounded capture. The answer of the invoker is checked strictly: anything that is not the bounded result shape, or
# whose reading tasks did not end, is an invalid capture (Valid = $false) and is never used.
function Invoke-DockerCliCapture {
    param([Parameter(Mandatory)][string[]]$Arguments, [Parameter(Mandatory)][int]$LimitBytes, [Parameter(Mandatory)][int]$TimeoutMs)
    $invalid = [pscustomobject]@{ Valid = $false; ExitCode = -1; Stdout = [byte[]]@(); Stderr = [byte[]]@(); StdoutExceeded = $false; StderrExceeded = $false; TimedOut = $false; Exited = $false; StreamsDrained = $false }
    $r = $null
    try { $r = & $script:DockerInvoker $Arguments ([pscustomobject]@{ LimitBytes = $LimitBytes; TimeoutMs = $TimeoutMs }) } catch { return $invalid }
    if ($null -eq $r -or $r -isnot [pscustomobject]) { return $invalid }
    $names = @($r.PSObject.Properties.Name)
    foreach ($n in 'ExitCode', 'Stdout', 'Stderr', 'StdoutExceeded', 'StderrExceeded', 'TimedOut', 'Exited', 'StreamsDrained') { if ($names -cnotcontains $n) { return $invalid } }
    if ($r.Stdout -isnot [byte[]] -or $r.Stderr -isnot [byte[]] -or $r.ExitCode -isnot [int]) { return $invalid }
    foreach ($n in 'StdoutExceeded', 'StderrExceeded', 'TimedOut', 'Exited', 'StreamsDrained') { if ($r.$n -isnot [bool]) { return $invalid } }
    if (-not $r.StreamsDrained -or $r.Stdout.Length -gt $LimitBytes + 1 -or $r.Stderr.Length -gt $LimitBytes + 1) { return $invalid }
    [pscustomobject]@{ Valid = $true; ExitCode = $r.ExitCode; Stdout = $r.Stdout; Stderr = $r.Stderr; StdoutExceeded = $r.StdoutExceeded; StderrExceeded = $r.StderrExceeded; TimedOut = $r.TimedOut; Exited = $r.Exited; StreamsDrained = $r.StreamsDrained }
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
        [Parameter(Mandatory)][long]$PropagationDelayMs,
        # run profile only (task 4.9-C2, D11, D12): the image ID of the gate (never the tag) and the checked, held input files of InputFileGuard
        [string]$ImageId, $InputGuard
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
        # The bind sources are the FINAL paths of the files that InputFileGuard checked and holds (one row per file of Get-InputFileTable;
        # the audit configuration is the fixture audit-config.mock.json at the fixed target /run/config/audit-config.json). Nothing else.
        if ([string]::IsNullOrEmpty($ImageId) -or $ImageId -cnotmatch '^sha256:[0-9a-f]{64}\z') { throw 'the run profile needs the image ID of the gate' }
        if ($null -eq $InputGuard -or $InputGuard -isnot [pscustomobject] -or @($InputGuard.PSObject.Properties.Name) -cnotcontains 'Kind' -or $InputGuard.Kind -cne 'input-file-guard' -or $InputGuard.Closed) { throw 'the run profile needs the open input file guard' }
        $table = Get-InputFileTable
        $entries = @($InputGuard.Entries)
        if ($entries.Count -ne $table.Count) { throw 'the input file guard does not hold the input file table' }
        foreach ($row in $table) {
            $e = @($entries | Where-Object { $_.Label -ceq $row.Label -and $_.RelPath -ceq $row.RelPath -and $_.Target -ceq $row.Target })
            if ($e.Count -ne 1 -or $e[0].Held.IsClosed) { throw 'the input file guard does not hold the input file table' }
            $src = [string]$e[0].MountSource
            if ($src.Contains(',') -or $src.Contains('=')) { throw 'a checked input file has a path that a mount specification cannot carry' }
            $a.Add('--mount'); $a.Add("type=bind,source=$src,target=$($row.Target),readonly")
        }
        $a.Add('--env'); $a.Add('HOME=/nonexistent')
        # no pull, ever: the image must already exist locally under exactly this ID (no tag, no fallback)
        $a.Add('--pull'); $a.Add('never')
        $a.Add($ImageId)
    }
    , $a.ToArray()
}
# The mounts a created container may have: exactly the ones of its profile (design: "Mounts (the complete list)").
function Get-ExpectedMountTargets {
    param([ValidateSet('run', 'probe')][string]$Profile)
    if ($Profile -eq 'probe') { return , @('/run/lease', '/run/out', '/workspace/node_modules', '/workspace/packages') }
    # the file targets are those of Get-InputFileTable (task 4.9-C2), the same set as before; plus the lease directory and the Run_Volume
    $table = Get-InputFileTable
    $t = @('/run/lease', '/run/out')
    foreach ($row in $table) { $t += [string]$row.Target }
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
# held by the caller. Returns Outcome (complete | incomplete), Step (of a failure), Disposition (never a removal), Location.
function Invoke-RunExport {
    [CmdletBinding()]
    param([Parameter(Mandatory)][string]$RepoRoot, [Parameter(Mandatory)][string]$RunId, [ValidateSet('run', 'probe')][string]$Profile = 'run', [string]$Summary)
    $p = Get-RunPaths -RepoRoot $RepoRoot -RunId $RunId
    $fail = {
        param($step, $dir, $mismatches, $detail)
        foreach ($d in @($p.Export, $p.Final)) { $m = Join-Path $d 'COMPLETE'; if (Test-Path -LiteralPath $m) { try { [System.IO.File]::Delete($m) } catch { } } }
        $reasonDir = if ($dir) { $dir } else { $p.Export }
        # (task 4.9-C2, D8) the existing detail first, then the closed-vocabulary summary of the caller (Get-ReasonSummary); same format
        $full = if ($Summary) { if ($detail) { "$detail; $Summary" } else { $Summary } } else { $detail }
        try { Write-ReasonFile -Directory $reasonDir -Step $step -RunId $RunId -Mismatches $mismatches -Detail $full } catch { }
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
    # 8. (G2-B1, 2026-11-26) the export never removes a volume. The volume is still referenced by the stopped container of the Run, and Docker
    # refuses to remove a referenced volume; Remove-RunVolume removes it after the provisional Launcher record and the container removal.
    # Disposition here is therefore provisional for a Run (kept_for_diagnosis); a probe diagnostic volume is never removed by the Launcher.
    if ($Profile -eq 'probe') { return [pscustomobject]@{ Outcome = 'complete'; Step = $null; Disposition = 'probe_diagnostic_kept'; Location = $p.Final } }
    [pscustomobject]@{ Outcome = 'complete'; Step = $null; Disposition = 'kept_for_diagnosis'; Location = $p.Final }
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
# The Launcher limit of a Run (task 4.9-B1; tasks.md 4.9(a), the runSeconds part, and 4.9(c)).
#
# What the limit is: a monitoring cap of the Launcher, runSeconds + 120 seconds, counted by the Launcher from the start of Wait-RuntimeContainer
# (after `docker start`). It is NOT the stop guarantee of the runtime: the runtime stops a Run within runSeconds + 30 seconds (R11.12, R11.17),
# and a killed Launcher is covered by the lease (R24.12). The 120 seconds are a margin chosen by decision, not a measured value; the cap does not
# prove R11.17 and is not a bound on the delay of a heartbeat-sized step. A probe keeps the fixed limit of $script:MaxRunSeconds.
#
# Acceptance of limits.runSeconds, equal to the runtime (strictParse and the schema "run-config": `type: integer`, 1 to 3600; the validator applies 1800
# only when the key is absent): the JSON NUMBER must be an integer VALUE (1800, 1800.0 and 1.8e3 are accepted as the runtime accepts them after parsing;
# 1.5 is not), and null, strings, booleans, arrays, and objects are refused (R11.8 (b)). The type is checked BEFORE any conversion: no parameter below is
# typed, so PowerShell cannot convert "1800", $true, or 1800.7 into a number first.

# The value of limits.runSeconds, after a JSON parse (ConvertFrom-JsonStrict gives [long] or [double] for a number). Ok and Seconds ([long]).
function Test-LauncherRunSeconds {
    param([AllowNull()]$Value)
    $bad = [pscustomobject]@{ Ok = $false; Seconds = $null }
    if ($null -eq $Value) { return $bad }
    if ($Value -is [int] -or $Value -is [long]) { $n = [long]$Value }
    elseif ($Value -is [double]) {
        if (-not [double]::IsFinite($Value) -or [Math]::Floor($Value) -ne $Value) { return $bad }
        if ($Value -lt $script:RunSecondsMin -or $Value -gt $script:RunSecondsMax) { return $bad }
        $n = [long]$Value
    }
    else { return $bad }
    if ($n -lt $script:RunSecondsMin -or $n -gt $script:RunSecondsMax) { return $bad }
    [pscustomobject]@{ Ok = $true; Seconds = [long]$n }
}

# The Launcher limit of a Run from validated runSeconds: capSeconds = runSeconds + 120, Ms = capSeconds * 1000. Ok is false for any invalid value.
function Get-LauncherRunLimitMs {
    param([AllowNull()]$RunSeconds)
    $v = Test-LauncherRunSeconds -Value $RunSeconds
    if (-not $v.Ok) { return [pscustomobject]@{ Ok = $false; Seconds = $null; CapSeconds = $null; Ms = $null } }
    $cap = [long]$v.Seconds + [long]$script:LauncherRunMarginSeconds
    [pscustomobject]@{ Ok = $true; Seconds = [long]$v.Seconds; CapSeconds = $cap; Ms = [long]($cap * 1000) }
}

# A member of a parsed JSON object by its EXACT name (ConvertFrom-JsonStrict returns case-insensitive dictionaries; the runtime compares case-sensitively).
function Get-LauncherJsonMember {
    param([Parameter(Mandatory)][System.Collections.IDictionary]$Dictionary, [Parameter(Mandatory)][string]$Name)
    foreach ($k in $Dictionary.Keys) { if ([string]$k -ceq $Name) { return [pscustomobject]@{ Found = $true; Value = $Dictionary[$k] } } }
    [pscustomobject]@{ Found = $false; Value = $null }
}

# The bytes of a held file, read from the HELD handle (positional reads, as InputFileGuard does; no stream wraps or closes the handle). $null on any failure.
function Read-LauncherHeldBytes {
    param([Parameter(Mandatory)]$Held, [Parameter(Mandatory)][long]$Size, [Parameter(Mandatory)][long]$MaxBytes)
    try {
        if ($null -eq $Held -or $Held.IsClosed -or $Size -lt 1 -or $Size -gt $MaxBytes) { return $null }
        $buf = [byte[]]::new([int]$Size)
        $off = [long]0
        while ($off -lt $Size) {
            $list = [System.Collections.Generic.List[System.Memory[byte]]]::new()
            $list.Add([System.Memory[byte]]::new($buf, [int]$off, [int]($Size - $off)))
            $n = [long][System.IO.RandomAccess]::Read($Held.Handle, $list, $off)
            if ($n -le 0) { return $null }
            $off += $n
        }
        $extra = [System.Collections.Generic.List[System.Memory[byte]]]::new()
        $extra.Add([System.Memory[byte]]::new([byte[]]::new(1)))
        if ([System.IO.RandomAccess]::Read($Held.Handle, $extra, $Size) -ne 0) { return $null }
        , $buf
    } catch { $null }
}

# The Launcher limit of a Run, read from the run-config.json that InputFileGuard holds (called after Open-InputFileGuard and before any lock or Docker call).
# The bytes are read again from the held handle and must have the SHA-256 that the guard recorded; then they are parsed with ConvertFrom-JsonStrict
# (duplicate keys, invalid JSON refused). The root must be an object; `limits` absent or an object; `runSeconds` absent (1800) or valid.
# Result: Ok, Code (null when Ok; a refusal code that never contains a value of the file), Seconds, CapSeconds, Ms, Defaulted. Never throws.
function Get-LauncherRunConfigLimit {
    param([Parameter(Mandatory)]$Guard)
    $fail = { param($code) [pscustomobject]@{ Ok = $false; Code = $code; Seconds = $null; CapSeconds = $null; Ms = $null; Defaulted = $false } }
    try {
        $e = Get-InputFileGuardEntry -Guard $Guard -Label 'run-config'
        if ($null -eq $e -or -not $e.HashRequired -or [string]$e.Sha256 -cnotmatch '^[0-9a-f]{64}$') { return (& $fail 'read_failed') }
        $bytes = Read-LauncherHeldBytes -Held $e.Held -Size ([long]$e.Size) -MaxBytes ([long]$e.MaxBytes)
        if ($null -eq $bytes) { return (& $fail 'read_failed') }
        if ((Get-Sha256Hex -Bytes $bytes) -cne [string]$e.Sha256) { return (& $fail 'changed') }
        try { $text = [System.Text.UTF8Encoding]::new($false, $true).GetString($bytes) } catch { return (& $fail 'not_utf8') }
        try { $doc = ConvertFrom-JsonStrict -Text $text } catch { return (& $fail 'invalid_json') }
        if ($doc -isnot [System.Collections.IDictionary]) { return (& $fail 'not_object') }
        $seconds = $script:RunSecondsDefault; $defaulted = $true
        $lim = Get-LauncherJsonMember -Dictionary $doc -Name 'limits'
        if ($lim.Found) {
            if ($lim.Value -isnot [System.Collections.IDictionary]) { return (& $fail 'limits_not_object') }
            $rs = Get-LauncherJsonMember -Dictionary $lim.Value -Name 'runSeconds'
            if ($rs.Found) {
                $chk = Test-LauncherRunSeconds -Value $rs.Value
                if (-not $chk.Ok) { return (& $fail 'run_seconds_invalid') }
                $seconds = $chk.Seconds; $defaulted = $false
            }
        }
        $limit = Get-LauncherRunLimitMs -RunSeconds $seconds
        if (-not $limit.Ok) { return (& $fail 'run_seconds_invalid') }
        [pscustomobject]@{ Ok = $true; Code = $null; Seconds = $limit.Seconds; CapSeconds = $limit.CapSeconds; Ms = $limit.Ms; Defaulted = $defaulted }
    } catch { & $fail 'read_failed' }
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
# Run_Volume removal and the cleanup record (G2-B1 and G2-B2, 2026-11-26; design.md, "Volume removal, the cleanup record, and abnormal ends").
# The closed vocabulary of the keep reason, in the deterministic order of the decision (the first rule that applies wins).
$script:VolumeKeepReasonOrder = @('profile_probe', 'stop_not_confirmed', 'export_incomplete', 'final_not_verified', 'run_not_normal', 'record_not_saved', 'container_not_removed', 'volume_kind_mismatch', 'rm_failed')

function Get-VolumeKeepReasons { , @($script:VolumeKeepReasonOrder) }

# The facts that make a Run a normal sealed end, known before the removal. The final Launcher exit code is NOT used (it is not known yet).
function Test-RunNormalEnd {
    param([bool]$Started, [AllowNull()][string]$EndCode, [AllowNull()][string]$Ended, $Report, $RuntimeReportRecord)
    if (-not $Started -or -not [string]::IsNullOrEmpty($EndCode) -or $Ended -cne 'container_stopped' -or $null -eq $Report -or $null -eq $RuntimeReportRecord) { return $false }
    $rx = $RuntimeReportRecord['runtimeExitCode']
    $null -ne $rx -and [long]$rx -eq 0 -and $Report.Classification -ceq 'runtime_sealed_normal' -and $Report.Consistency -ceq 'consistent' -and $Report.CompleteEligible -eq $true -and $Report.LauncherExitCode -eq 0
}

# The final location of a complete export passes the reader acceptance again.
function Test-ExportFinalVerified {
    param($Export)
    $null -ne $Export -and $Export.Outcome -ceq 'complete' -and (Test-Path -LiteralPath $Export.Location -PathType Container) -and [bool](Test-CompletedRun -Path $Export.Location)
}

# The first keep reason that applies, or $null. -Provisional decides rules 1 to 5 only (before the provisional record is written).
function Get-VolumeKeepReason {
    param([bool]$IsRun, [bool]$StopConfirmed, $Export, [bool]$FinalVerified, [bool]$Normal, [switch]$Provisional, [bool]$RecordSaved, [AllowNull()][string]$ContainerOutcome)
    if (-not $IsRun) { return 'profile_probe' }
    if (-not $StopConfirmed) { return 'stop_not_confirmed' }
    if ($null -eq $Export -or $Export.Outcome -cne 'complete') { return 'export_incomplete' }
    if (-not $FinalVerified) { return 'final_not_verified' }
    if (-not $Normal) { return 'run_not_normal' }
    if ($Provisional) { return $null }
    if (-not $RecordSaved) { return 'record_not_saved' }
    if (@('removed', 'absent') -cnotcontains $ContainerOutcome) { return 'container_not_removed' }
    $null
}

# The identity of the Run_Volume: its name, its role label, its run-id label, and its volume-kind label equal the expected values. A volume that
# does not exist, or an inspect that fails, is not confirmed (false). No Docker text is kept.
function Test-RunVolumeIdentity {
    param([Parameter(Mandatory)][string]$Volume, [Parameter(Mandatory)][string]$RunId)
    try {
        $r = Invoke-DockerCli -Arguments @('volume', 'inspect', '--format', '{{.Name}}|{{index .Labels "phoenix.discovery.role"}}|{{index .Labels "phoenix.discovery.run-id"}}|{{index .Labels "phoenix.discovery.volume-kind"}}', $Volume)
        if ($r.ExitCode -ne 0) { return $false }
        $f = ([string]$r.Output).Trim().Split('|')
        $f.Count -eq 4 -and $f[0] -ceq $Volume -and $f[1] -ceq 'run-volume' -and $f[2] -ceq $RunId -and $f[3] -ceq 'run'
    } catch { $false }
}

# Removes the Run_Volume of a normal `run` Run only when every condition holds; otherwise keeps it with the reason. Result: Outcome (removed | kept), Reason
# (null when removed). `docker volume rm` is called without a force option, and only after every other condition was confirmed. `removed` is returned only
# after that call succeeded.
function Remove-RunVolume {
    param(
        [Parameter(Mandatory)][string]$RunId, [Parameter(Mandatory)][string]$Volume, [bool]$IsRun, [bool]$StopConfirmed, $Export, [Parameter(Mandatory)][string]$FinalPath,
        [bool]$Normal, [bool]$RecordSaved, [AllowNull()][string]$ContainerOutcome
    )
    $kept = { param($reason) [pscustomobject]@{ Outcome = 'kept'; Reason = $reason } }
    $finalOk = $false
    if ($IsRun -and $StopConfirmed -and $null -ne $Export -and $Export.Outcome -ceq 'complete') { try { $finalOk = Test-ExportFinalVerified -Export ([pscustomobject]@{ Outcome = $Export.Outcome; Location = $FinalPath }) } catch { $finalOk = $false } }
    $why = Get-VolumeKeepReason -IsRun $IsRun -StopConfirmed $StopConfirmed -Export $Export -FinalVerified $finalOk -Normal $Normal -RecordSaved $RecordSaved -ContainerOutcome $ContainerOutcome
    if ($null -ne $why) { return (& $kept $why) }
    if (-not (Test-RunVolumeIdentity -Volume $Volume -RunId $RunId)) { return (& $kept 'volume_kind_mismatch') }
    $rm = $null
    try { $rm = Invoke-DockerCli -Arguments @('volume', 'rm', $Volume) } catch { return (& $kept 'rm_failed') }
    if ($rm.ExitCode -ne 0) { return (& $kept 'rm_failed') }
    [pscustomobject]@{ Outcome = 'removed'; Reason = $null }
}
# ---------------------------------------------------------------------------------------------------------------------
# Integration helpers (task 4.9-C2). Every code below is a closed Launcher code; nothing carries a path, a nonce, or text of Docker or the runtime.
$script:RuntimeReportMaxBytes = 8192
# The time limit of `docker logs` on a container that is ALREADY stopped (confirmed): the call only reads a finished log of at most 8 KiB.
# 30 s covers a slow Docker Desktop CLI start; it is not part of the Run time (MaxRunSeconds and the lease rules are unchanged).
$script:LogsTimeoutMs = 30000
$script:NormalOutcomeEnded = 'ended'

# D of the lease timing record as main.ts accepts it: an integer of 0 to 999999 (PHOENIX_LEASE_D_MS, ^[0-9]{1,6}$). The lease timing rules
# (Test-LeaseTimingRecord) stay in force and are stricter in practice; this check never relaxes them.
function Test-PropagationDelayValue {
    param([AllowNull()]$Value)
    ($Value -is [long] -or $Value -is [int]) -and $Value -ge 0 -and $Value -le 999999
}

# The image of the CREATED container, read from that container (not from the tag), with its identity: the full ID returned by create, the
# Run identifier label, and the runtime role label. Result: Ok, Code (image_inspect_failed | container_identity_mismatch), ImageId.
function Get-CreatedContainerImage {
    param([string]$ContainerId, [string]$RunId)
    $fail = { param($c) [pscustomobject]@{ Ok = $false; Code = $c; ImageId = $null } }
    if (-not $ContainerId -or $ContainerId -cnotmatch '^[0-9A-Za-z_.-]+$') { return (& $fail 'container_identity_mismatch') }
    $r = Invoke-DockerCli -Arguments @('inspect', '--format', '{{.Image}}|{{.Id}}|{{index .Config.Labels "phoenix.discovery.run-id"}}|{{index .Config.Labels "phoenix.discovery.role"}}', $ContainerId)
    if ($r.ExitCode -ne 0) { return (& $fail 'image_inspect_failed') }
    $f = $r.Output.Trim().Split('|')
    if ($f.Count -ne 4 -or $f[0] -cnotmatch '^sha256:[0-9a-f]{64}\z') { return (& $fail 'image_inspect_failed') }
    if ($f[1] -cne $ContainerId -or $f[2] -cne $RunId -or $f[3] -cne 'runtime') { return (& $fail 'container_identity_mismatch') }
    [pscustomobject]@{ Ok = $true; Code = $null; ImageId = $f[0] }
}

# The Launcher record view of a RuntimeReport result: closed codes, booleans, and integers only. Values of a parsed line are under `values`
# with `trusted` = consistent only; a refused line has no `values`. Nothing here is an independent verification of the seal or of a purpose.
function ConvertTo-RuntimeReportRecord {
    param($Report, $Capture, [bool]$ExitCodeKnown, [int]$RuntimeExitCode)
    $o = [ordered]@{
        source = 'docker_logs_stderr'; independentVerification = $false; purposeAssessment = 'not_assessed'
        capture = [ordered]@{
            valid = [bool]$Capture.Valid; cliExitCode = [long]$Capture.ExitCode; stderrBytes = [long]$Capture.Stderr.Length; stdoutBytes = [long]$Capture.Stdout.Length
            stderrExceeded = [bool]$Capture.StderrExceeded; stdoutExceeded = [bool]$Capture.StdoutExceeded; timedOut = [bool]$Capture.TimedOut
        }
        runtimeExitCode = $(if ($ExitCodeKnown) { [long]$RuntimeExitCode } else { $null })
        status = [string]$Report.Status; reportCode = $Report.ReportCode; consistency = [string]$Report.Consistency; classification = [string]$Report.Classification
        completeEligible = [bool]$Report.CompleteEligible; launcherExitCode = [long]$Report.LauncherExitCode
    }
    if ($Report.Status -ceq 'parsed') {
        $o['values'] = [ordered]@{
            trusted = ($Report.Consistency -ceq 'consistent'); phase = $Report.Phase; sealed = $Report.Sealed; started = $Report.Started
            terminationReason = $Report.TerminationReason; terminationClass = $Report.TerminationClass; failure = $Report.Failure; code = $Report.Code
            codes = @($Report.Codes | ForEach-Object { [string]$_ }); refusals = @($Report.Refusals | ForEach-Object { [ordered]@{ check = [string]$_.Check; code = [string]$_.Code } })
            timers = @($Report.Timers | ForEach-Object { [string]$_ })
        }
    }
    $o
}

# After the stop is confirmed: the exit code of the runtime container and its ONE standard-error line, captured with the 8 KiB bound, and
# classified by ConvertFrom-RuntimeReport. A failed or timed-out `docker logs`, an over-long standard output, or reading tasks that did not end
# give `logs_unavailable` (the bytes are not parsed). An over-long standard error is passed to the parser, which refuses it (report_too_large).
function Get-RuntimeExitReport {
    param([Parameter(Mandatory)][string]$ContainerId)
    $ex = Invoke-DockerCli -Arguments @('inspect', '--format', '{{.State.ExitCode}}', $ContainerId)
    $txt = $ex.Output.Trim()
    $known = $ex.ExitCode -eq 0 -and $txt -cmatch '^-?[0-9]{1,9}\z'
    $code = if ($known) { [int]$txt } else { -1 }
    $cap = Invoke-DockerCliCapture -Arguments @('logs', $ContainerId) -LimitBytes $script:RuntimeReportMaxBytes -TimeoutMs $script:LogsTimeoutMs
    $usable = $cap.Valid -and -not $cap.TimedOut -and -not $cap.StdoutExceeded -and $cap.Exited
    if ($usable -and $cap.StderrExceeded) { $rep = ConvertFrom-RuntimeReport -Bytes $cap.Stderr -ExitCode $code }
    elseif ($usable -and $cap.ExitCode -eq 0) { $rep = ConvertFrom-RuntimeReport -Bytes $cap.Stderr -ExitCode $code }
    else { $rep = ConvertFrom-RuntimeReport -Bytes $null -ExitCode $code; $rep.Status = 'unavailable'; $rep.ReportCode = 'logs_unavailable' }
    [pscustomobject]@{ Report = $rep; Record = (ConvertTo-RuntimeReportRecord -Report $rep -Capture $cap -ExitCodeKnown $known -RuntimeExitCode $code) }
}

# The Reason_File summary (D8): `key=value` pairs separated by `; `, each value a token of a closed vocabulary (checked again by a pattern).
function Get-ReasonSummary {
    param([AllowNull()][string]$LauncherCode, $Report)
    $parts = [System.Collections.Generic.List[string]]::new()
    $add = { param($k, $v) if ($v -is [string] -and $v -cmatch '^[A-Za-z0-9_]{1,64}\z') { $parts.Add("$k=$v") } }
    & $add 'launcher' $LauncherCode
    if ($null -ne $Report) {
        & $add 'runtime_classification' $Report.Classification
        & $add 'runtime_report' $Report.Status
        & $add 'runtime_report_code' $Report.ReportCode
        & $add 'runtime_phase' $Report.Phase
        & $add 'runtime_termination' $Report.TerminationReason
        & $add 'runtime_failure' $Report.Failure
        & $add 'runtime_code' $Report.Code
    }
    $parts -join '; '
}

# The Launcher outcome of a started Run (D4). `complete` needs BOTH a normal sealed end that is consistent with its exit code
# (CompleteEligible) AND a complete export. Neither says that the purpose of the Run was met.
function Get-RunOutcome {
    param($Report, $Export)
    $exportComplete = $null -ne $Export -and $Export.Outcome -eq 'complete'
    if ($null -eq $Report) { return [pscustomobject]@{ Code = 'runtime_report_invalid'; ExitCode = 1 } }
    $eligible = $Report.CompleteEligible -eq $true -and $Report.Classification -ceq 'runtime_sealed_normal' -and $Report.Consistency -ceq 'consistent' -and $Report.LauncherExitCode -eq 0
    if ($eligible -and $exportComplete) { return [pscustomobject]@{ Code = 'complete'; ExitCode = 0 } }
    if ($Report.Classification -ceq 'runtime_sealed_abnormal') { return [pscustomobject]@{ Code = 'runtime_sealed_abnormal'; ExitCode = 1 } }
    if ($eligible) { return [pscustomobject]@{ Code = $script:NormalOutcomeEnded; ExitCode = 1 } }
    $c = [string]$Report.Classification
    if ($c -cnotmatch '^runtime_[a-z_]{1,48}\z') { $c = 'runtime_report_invalid' }
    [pscustomobject]@{ Code = $c; ExitCode = 1 }
}

# ---------------------------------------------------------------------------------------------------------------------
# Retention of the resources of a Run whose container is NOT confirmed stopped (task 4.9-C2). Measured 2026-11-25 in a pwsh child process:
# when the last reference is gone, the garbage collector closes a SafeFileHandle, a FileStream, and a named Mutex (the mutex is then destroyed
# and a new one is acquired). So the input file guard and the locks of such a Run are kept in a static field of a .NET type: process-wide,
# independent of the module scope (Import-Module -Force, Remove-Module) and of the runspace. The store is ADD-ONLY: keyed by the Run
# identifier, an existing entry is never replaced, and there is no removal and no release function. Only the Run identifiers can be queried;
# nothing of the entry is logged or recorded. NOT claimed: anything after the process ends (the operating system closes every handle then).
$script:RetentionSource = @'
using System.Collections.Concurrent;
namespace Phoenix.Launcher
{
    // Process-wide, add-only. Nothing removes or replaces an entry; the objects stay referenced until the process ends.
    public static class UnstoppedRunRetention
    {
        static readonly ConcurrentDictionary<string, object> Held = new ConcurrentDictionary<string, object>(System.StringComparer.Ordinal);
        public static bool Add(string runId, object resources) { return runId != null && resources != null && Held.TryAdd(runId, resources); }
        public static bool Contains(string runId) { return runId != null && Held.ContainsKey(runId); }
        public static int Count { get { return Held.Count; } }
    }
}
'@

function Initialize-RunRetention { if (-not ('Phoenix.Launcher.UnstoppedRunRetention' -as [type])) { Add-Type -TypeDefinition $script:RetentionSource -Language CSharp -ErrorAction Stop } }

# Called only when a container of this Run exists and its stop is not confirmed. $true when the entry was added (or was already there).
function Save-UnstoppedRunResources {
    param([Parameter(Mandatory)][string]$RunId, $Guard, $Locks)
    Initialize-RunRetention
    if ([Phoenix.Launcher.UnstoppedRunRetention]::Contains($RunId)) { return $true }
    [Phoenix.Launcher.UnstoppedRunRetention]::Add($RunId, [pscustomobject]@{ Guard = $Guard; Locks = $Locks })
}

# Read-only views for the tests and the diagnosis: whether a Run identifier is retained, and how many are. No entry content is returned.
function Test-UnstoppedRunRetained { param([string]$RunId) Initialize-RunRetention; [Phoenix.Launcher.UnstoppedRunRetention]::Contains($RunId) }
function Get-UnstoppedRunRetainedCount { Initialize-RunRetention; [int][Phoenix.Launcher.UnstoppedRunRetention]::Count }
# ---------------------------------------------------------------------------------------------------------------------
# One start, from the gate to the release of the Run lock. Exit codes: 0 complete (or probe ended), 1 incomplete or error end,
# 2 refused before any side effect (an argument, the gate, the timing record, an input file, a lock), 3 refused after the locks
# (collision, recovery, image, facts, inspection, input file re-check).
#
# Order (task 4.9-C2; R15.11): (0) the arguments; (1) the gate and D; (2) the input files (pre-volume; they are then HELD until the stop of the
# container is confirmed); (3) the locks; recovery, Run ID; (4) the Run_Volume and its owner; (5) the nonce and the lease (lease.json once);
# (6) create with the image ID; (7) the image of the created container and its identity, against the gate; (8) launcher-facts.json v2,
# exclusive, read back; (9) mount_inspection and the attestation; (10) the held input files again; (11) start. Any failure from (6) to (10)
# starts nothing. A probe skips (0)'s audit configuration, (2), (7), (8), (10), and the runtime report.
function Invoke-DiscoveryStart {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)][string]$RepoRoot,
        [Parameter(Mandatory)][ValidateSet('run', 'probe')][string]$Profile,
        [Parameter(Mandatory)][string]$MutexName,
        [Parameter(Mandatory)][string]$LockPath,
        [string]$ApprovalStorePath,
        [string]$LeaseTimingPath,
        [AllowEmptyString()][AllowNull()][string]$AuditConfig,
        [scriptblock]$Log = { param($m) Write-Host $m }
    )
    & $Log $script:ScopeNote
    $result = { param($exit, $code, $extra = @{}) $o = [ordered]@{ ExitCode = $exit; Code = $code }; foreach ($k in $extra.Keys) { $o[$k] = $extra[$k] }; [pscustomobject]$o }

    # (0) a Run needs exactly -AuditConfig fixture (case-sensitive; no default; no fallback; decision of 2026-11-25); a probe takes none
    $auditGiven = $PSBoundParameters.ContainsKey('AuditConfig')
    if ($Profile -eq 'probe') {
        if ($auditGiven) { & $Log 'refused: audit_config_with_probe'; return (& $result 2 'audit_config_with_probe') }
    } else {
        if (-not $auditGiven) { & $Log 'refused: audit_config_missing'; return (& $result 2 'audit_config_missing') }
        if ($AuditConfig -cne 'fixture') { & $Log 'refused: audit_config_invalid'; return (& $result 2 'audit_config_invalid') }
    }

    # (1)
    $gate = Test-LaunchGate -RepoRoot $RepoRoot -Profile $Profile -ApprovalStorePath $ApprovalStorePath -LeaseTimingPath $LeaseTimingPath
    if (-not $gate.Ok) { & $Log "refused: $($gate.Code) ($($gate.Detail))"; return (& $result 2 $gate.Code) }
    if (-not (Test-PropagationDelayValue -Value $gate.Timing.D)) { & $Log 'refused: lease_timing_d_invalid'; return (& $result 2 'lease_timing_d_invalid') }

    # (2) pre-volume: every bind-mount source of a Run, opened and held
    $guard = $null
    $maxRunMs = [long]($script:MaxRunSeconds * 1000)   # a probe: the fixed limit; a Run: set from run-config.json below
    if ($Profile -eq 'run') {
        $opened = Open-InputFileGuard -RepoRoot $RepoRoot -Table (Get-InputFileTable)
        if (-not $opened.Ok) { & $Log "refused: input_file_refused ($($opened.Label):$($opened.Code))"; return (& $result 2 'input_file_refused' @{ InputFileLabel = $opened.Label; InputFileCode = $opened.Code }) }
        $guard = $opened.Guard
        # (2b) task 4.9-B1: the Launcher limit of this Run, from the held run-config.json (runSeconds + 120 s). A refusal is a pre-volume refusal: no lock is
        # held and nothing exists yet, so only the input file handles are released; the refused value is never logged.
        $runLimit = Get-LauncherRunConfigLimit -Guard $guard
        if (-not $runLimit.Ok) {
            Close-InputFileGuard -Guard $guard
            & $Log "refused: input_file_refused (run-config:$($runLimit.Code))"
            return (& $result 2 'input_file_refused' @{ InputFileLabel = 'run-config'; InputFileCode = $runLimit.Code })
        }
        $maxRunMs = [long]$runLimit.Ms
    }

    $runId = $null; $lease = $null; $container = $null; $containerId = $null; $exportResult = $null; $stopConfirmed = $false; $wait = $null; $endCode = $null
    $started = $false; $report = $null; $runFinal = $null; $locks = $null; $recordFailed = $false
    try {
        $locks = Enter-DiscoveryLocks -MutexName $MutexName -LockPath $LockPath
        if (-not $locks.Ok) { & $Log "refused: $($locks.Code)"; return (& $result 2 $locks.Code) }

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
            if ($Profile -eq 'run') {
                $rc = Get-InputFileGuardEntry -Guard $guard -Label 'run-config'
                $ac = Get-InputFileGuardEntry -Guard $guard -Label 'audit-config'
                $record['auditConfig'] = [ordered]@{ switch = 'fixture'; relPath = [string]$ac.RelPath; sha256 = [string]$ac.Sha256; kindDeclaredByLauncher = 'fixture' }
                $record['runConfig'] = [ordered]@{ relPath = [string]$rc.RelPath; sha256 = [string]$rc.Sha256 }
                $record['inputFiles'] = @($guard.Entries | ForEach-Object { [ordered]@{ label = [string]$_.Label; relPath = [string]$_.RelPath; sizeBytes = [long]$_.Size } })
            }

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
                $record['volumeCleanup'] = [ordered]@{ outcome = 'kept'; reason = 'export_incomplete' }
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
            $createArgs = if ($Profile -eq 'run') { New-ContainerCreateArgs -Profile $Profile -RepoRoot $RepoRoot -RunId $runId -Nonce $nonce -PropagationDelayMs ([long]$gate.Timing.D) -ImageId $gate.ImageDigest -InputGuard $guard }
                          else { New-ContainerCreateArgs -Profile $Profile -RepoRoot $RepoRoot -RunId $runId -Nonce $nonce -PropagationDelayMs ([long]$gate.Timing.D) }
            $create = Invoke-DockerCli -Arguments $createArgs
            if ($create.ExitCode -ne 0) { $endCode = 'container_create_failed'; & $Log 'refused: container_create_failed'; return (& $result 3 $endCode @{ RunId = $runId }) }
            $containerId = $create.Output.Trim()
            $record['containerId'] = $containerId

            if ($Profile -eq 'run') {
                # (7) the image of the created container itself, against the image ID of the gate (exact)
                $ci = Get-CreatedContainerImage -ContainerId $containerId -RunId $runId
                $record['runtimeImage'] = [ordered]@{ gateImageId = $gate.ImageDigest; createdContainerImageId = $ci.ImageId; match = ($ci.Ok -and $ci.ImageId -ceq $gate.ImageDigest) }
                if (-not $ci.Ok) { $endCode = $ci.Code; & $Log "refused: $endCode"; return (& $result 3 $endCode @{ RunId = $runId }) }
                if ($ci.ImageId -cne $gate.ImageDigest) { $endCode = 'runtime_image_mismatch'; & $Log 'refused: runtime_image_mismatch'; return (& $result 3 $endCode @{ RunId = $runId }) }
                # (8) launcher-facts.json v2: the hash is the one InputFileGuard read from the held handle; the image ID is the created container's.
                # runtime_image_id and audit_config_kind are DECLARATIONS of the Launcher; the runtime does not verify them.
                $facts = Write-LauncherFactsFile -LeaseDir $p.Lease -RunId $runId -RuntimeImageId $ci.ImageId -AuditConfigSha256 ([string]$ac.Sha256) -AuditConfigKind 'fixture'
                $record['launcherFacts'] = [ordered]@{ schemaVersion = [long]2; outcome = $(if ($facts.Ok) { 'written' } else { 'refused' }); code = $facts.Code; sha256 = $facts.Sha256; declaredByLauncher = @('audit_config_kind', 'runtime_image_id') }
                if (-not $facts.Ok) { $endCode = 'launcher_facts_failed'; & $Log "refused: launcher_facts_failed ($($facts.Code))"; return (& $result 3 $endCode @{ RunId = $runId }) }
            }

            # (9)
            $inspection = Get-MountInspection -Container $container -Profile $Profile
            Write-TextAtomically -Path (Join-Path $p.Lease 'isolation-attestation.json') -Text ((ConvertTo-CanonicalJson -Value $inspection.Attestation) + "`n")
            if (-not $inspection.Ok) { $endCode = 'mount_inspection_failed'; & $Log "refused: mount_inspection_failed ($($inspection.Problems -join ','))"; return (& $result 3 $endCode @{ RunId = $runId }) }

            # (10) the held input files are still the checked ones
            if ($Profile -eq 'run') {
                $cf = Confirm-InputFileGuard -Guard $guard
                $record['inputFileRecheck'] = [ordered]@{ ok = [bool]$cf.Ok; code = $cf.Code; label = $cf.Label }
                if (-not $cf.Ok) { $endCode = 'input_file_changed'; & $Log "refused: input_file_changed ($($cf.Label):$($cf.Code))"; return (& $result 3 $endCode @{ RunId = $runId }) }
            }

            # (11)
            if ((Invoke-DockerCli -Arguments @('start', $container)).ExitCode -ne 0) { $endCode = 'container_start_failed'; return (& $result 1 $endCode @{ RunId = $runId }) }
            $started = $true
            $wait = Wait-RuntimeContainer -Container $container -Lease $lease -Settings $settings -MaxRunMs $maxRunMs
            $record['heartbeats'] = [long]$wait.Beats
            $record['lateHeartbeats'] = [long]$wait.LateBeats
            $record['ended'] = $wait.Ended
            $exitCode = (Invoke-DockerCli -Arguments @('inspect', '--format', '{{.State.ExitCode}}', $container)).Output.Trim()
            $record['containerExitCode'] = $exitCode
            if ($Profile -eq 'probe') { $endCode = if ($wait.Ended -eq 'container_stopped' -and $exitCode -eq '0') { 'ended' } else { 'error_end' } }
            elseif ($wait.Ended -ne 'container_stopped') { $endCode = 'error_end' }
        } finally {
            # Normal or error end (R24.11), in this order (2026-11-14): (1) the container has ended; (2) stop and confirm, revoke the lease;
            # (3) export (it removes no volume) and check that the evidence is saved; (4) write the provisional Launcher record (the diagnostic
            # record; volumeCleanup pending or kept); (5) remove this Run's own container only, and only if the stop is confirmed, the evidence is
            # saved, the record is written, and its identity is confirmed; (6) (G2-B1) remove the Run_Volume with Remove-RunVolume only when every
            # removal condition holds (a probe volume is always kept); (7) write the final Launcher record; (8) release the conformance mutex and
            # the Run lock. A container that is not confirmed stopped keeps both held until this process ends, and that rule has priority.
            # (task 4.9-C2) after (2): the runtime report of a started Run; the input file handles are released (outer finally) only when the stop is confirmed.
            if ($null -ne $container) { $stopConfirmed = Stop-ContainerConfirmed -Container $container; $record['containerStopConfirmed'] = $stopConfirmed }
            if ($Profile -eq 'run' -and $started -and $stopConfirmed) {
                try { $rr = Get-RuntimeExitReport -ContainerId $containerId; $report = $rr.Report; $record['runtimeReport'] = $rr.Record }
                catch { $report = $null; $record['runtimeReport'] = [ordered]@{ status = 'unavailable'; reportCode = 'logs_unavailable'; classification = 'runtime_report_invalid'; completeEligible = $false } }
            }
            if ($null -ne $guard) { $record['inputFileHandles'] = $(if ($null -eq $container -or $stopConfirmed) { 'released_after_stop' } else { 'kept_stop_not_confirmed' }) }
            if ($null -ne $lease) { try { Revoke-RunLease -Lease $lease } catch { } }
            $recordPath = $null; $recordOutcome = $null; $containerOutcome = $null; $recordFailed = $false; $normalEnd = $false
            $isRun = ($Profile -eq 'run'); $stopOk = ($null -eq $container -or $stopConfirmed)
            try {
                if ($null -ne $lease -and $null -ne $container -and $stopConfirmed) {
                    if ($Profile -eq 'run') { $exportResult = Invoke-RunExport -RepoRoot $RepoRoot -RunId $runId -Profile $Profile -Summary (Get-ReasonSummary -LauncherCode $endCode -Report $report) }
                    else { $exportResult = Invoke-RunExport -RepoRoot $RepoRoot -RunId $runId -Profile $Profile }
                    $record['export'] = [ordered]@{ outcome = $exportResult.Outcome; step = $exportResult.Step }
                    if ($Profile -eq 'probe') { $record['volumeRemoval'] = 'requires_human_approval' }
                    $recordOutcome = $exportResult.Outcome
                } elseif ($null -ne $runId -and $null -ne $lease) {
                    $recordOutcome = 'incomplete'
                }
                if ($Profile -eq 'run' -and $started -and $null -eq $endCode) {
                    $runFinal = Get-RunOutcome -Report $report -Export $exportResult
                    $record['launcherResult'] = [ordered]@{ code = $runFinal.Code; exitCode = [long]$runFinal.ExitCode; purposeAssessment = 'not_assessed' }
                }
                if ($null -ne $recordOutcome) {
                    # (G2-B1) the provisional record: the volume is kept (provisionally) and the cleanup is `pending`, or `kept` when a rule 1 to 5 already applies
                    $normalEnd = Test-RunNormalEnd -Started $started -EndCode $endCode -Ended $(if ($null -ne $wait) { $wait.Ended } else { $null }) -Report $report -RuntimeReportRecord $record['runtimeReport']
                    $why = Get-VolumeKeepReason -IsRun $isRun -StopConfirmed $stopOk -Export $exportResult -FinalVerified (Test-ExportFinalVerified -Export $exportResult) -Normal $normalEnd -Provisional
                    $record['volumeDisposition'] = 'kept_for_diagnosis'
                    $record['volumeCleanup'] = $(if ($null -ne $why) { [ordered]@{ outcome = 'kept'; reason = $why } } else { [ordered]@{ outcome = 'pending'; reason = $null } })
                    if ($null -ne $container) { $record['containerRemoval'] = [ordered]@{ outcome = 'pending' } }
                    $recordPath = Write-LauncherRecord -RepoRoot $RepoRoot -RunId $runId -Record $record -Outcome $recordOutcome
                }
            } catch { $recordFailed = $true; & $Log "error: the export or the Launcher record failed: $($_.Exception.Message)" }
            try {
                if ($null -ne $container) {
                    $saved = Test-EvidenceSaved -Export $exportResult -RecordPath $recordPath
                    $removal = Remove-OwnRunContainer -ContainerId $containerId -RunId $runId -StopConfirmed $stopConfirmed -EvidenceSaved $saved
                    $containerOutcome = $removal.Outcome
                    $record['containerRemoval'] = [ordered]@{ outcome = $removal.Outcome; reason = $removal.Reason }
                    if ($removal.Outcome -eq 'kept') { & $Log "warning: container kept ($($removal.Reason)): $container" }
                }
            } catch { & $Log "error: the container removal step failed: $($_.Exception.Message)" }
            try {
                # (G2-B1) the volume is removed only now (after the provisional record and the container removal), then the final record is written
                if ($null -ne $recordOutcome -and $record.Contains('volumeCleanup')) {
                    $vc = Remove-RunVolume -RunId $runId -Volume $p.Volume -IsRun $isRun -StopConfirmed $stopOk -Export $exportResult -FinalPath $p.Final -Normal $normalEnd -RecordSaved ($null -ne $recordPath) -ContainerOutcome $containerOutcome
                    $record['volumeCleanup'] = [ordered]@{ outcome = $vc.Outcome; reason = $vc.Reason }
                    $record['volumeDisposition'] = $(if ($vc.Outcome -ceq 'removed') { 'removed_after_verified_export' } else { 'kept_for_diagnosis' })
                    if ($vc.Outcome -ceq 'kept') { & $Log "warning: volume kept ($($vc.Reason)): $($p.Volume)" }
                }
                if ($null -ne $recordOutcome) {
                    if ($null -ne $recordPath) { Write-TextAtomically -Path $recordPath -Text ((ConvertTo-CanonicalJson -Value $record) + "`n") }
                    else { $recordFailed = $true }
                }
            } catch { $recordFailed = $true; & $Log "error: the volume removal or the final Launcher record failed: $($_.Exception.Message)" }
            finally {
                if ($null -eq $container -or $stopConfirmed) { Exit-ConformanceMutex -Locks $locks; Exit-RunLock -Locks $locks }
                else { & $Log 'error: the container is not confirmed stopped; the conformance mutex and the Run lock are released only when this process ends' }
            }        }
    } finally {
        # The input file handles: released on every path, except while a container of this Run is not confirmed stopped (then they stay
        # held, like the locks, for as long as this process lives; the operating system closes them when the process ends).
        if ($null -ne $guard) {
            if ($null -eq $container -or $stopConfirmed) { Close-InputFileGuard -Guard $guard }
            else { & $Log 'error: the container is not confirmed stopped; the input file handles are kept while this process lives' }
        }
        # Not confirmed stopped: the guard (if any) and the locks are retained for this Run identifier (add-only, process-wide), so that the
        # garbage collector cannot close them after this function returns. Nothing is retained on any other path.
        if ($null -ne $container -and -not $stopConfirmed -and $null -ne $runId) {
            try { [void](Save-UnstoppedRunResources -RunId $runId -Guard $guard -Locks $locks) } catch { & $Log 'error: the resources of the unstopped Run could not be retained' }
        }
    }
    $final = if ($null -ne $runFinal) { & $result $runFinal.ExitCode $runFinal.Code @{ RunId = $runId; Export = $exportResult; Report = $report } }
             elseif ($null -ne $exportResult -and $exportResult.Outcome -eq 'complete' -and $endCode -eq 'ended') { & $result 0 'complete' @{ RunId = $runId; Export = $exportResult } }
             else { & $result 1 $(if ($endCode) { $endCode } else { 'incomplete' }) @{ RunId = $runId; Export = $exportResult; Report = $report } }
    # (G2-B1) a Launcher record that could not be saved is never a normal end; an end that was already an error keeps its own code
    if ($recordFailed -and $final.ExitCode -eq 0) { return (& $result 1 'launcher_record_not_saved' @{ RunId = $runId; Export = $exportResult; Report = $report }) }
    $final
}
# ---------------------------------------------------------------------------------------------------------------------
# launcher-facts.json version 2 and exclusive file creation (task 4.9-C1; the facts file is read by packages/discovery-loop/src/runtimeFacts/
# launcherFacts.ts). These functions are NOT called by Invoke-DiscoveryStart yet (the wiring is task 4.9-C2) and they change no existing function.
#
# The contract (closed set of six keys, at most 4096 bytes), mirrored from launcherFacts.ts; a test compares the constants with that file:
#   schema_version 2 | issued_by "launcher" | run_id | runtime_image_id "sha256:<64 hex>" | audit_config_sha256 <64 hex> | audit_config_kind "fixture"
# `runtime_image_id` and `audit_config_kind` are DECLARATIONS of the Launcher; the runtime does not verify them. The file is UTF-8 without a
# byte-order mark and without a trailing line feed (the canonical text, as lease.json).
#
# Differences from the TypeScript parser, all on the strict side: a JSON number that is not written as the integer 2 is refused; a key that
# differs only in letter case is refused as missing/unknown (as the TypeScript parser does); a deeper nesting is reported as a field problem
# and not as invalid JSON; bytes with a byte-order mark, a trailing line feed, or any non-canonical spelling are refused by the bytes check.
$script:LauncherFactsMaxBytes = 4096
$script:LauncherFactsKeys = @('audit_config_kind', 'audit_config_sha256', 'issued_by', 'run_id', 'runtime_image_id', 'schema_version')
$script:LauncherFactsKinds = @('fixture')
$script:LauncherFactsSchemaVersion = 2
$script:FactsRunIdPattern = '^run-[0-9]{8}T[0-9]{6}Z-[0-9a-f]{12}\z'
$script:FactsImageIdPattern = '^sha256:[0-9a-f]{64}\z'
$script:FactsSha256Pattern = '^[0-9a-f]{64}\z'
$script:FactsZeroSha256 = '0' * 64
$script:FactsUtf8Strict = [System.Text.UTF8Encoding]::new($false, $true)

function Get-LauncherFactsContract {
    [pscustomobject]@{
        MaxBytes = $script:LauncherFactsMaxBytes; Keys = @($script:LauncherFactsKeys); Kinds = @($script:LauncherFactsKinds); SchemaVersion = $script:LauncherFactsSchemaVersion
        RunIdPattern = $script:FactsRunIdPattern; ImageIdPattern = $script:FactsImageIdPattern; Sha256Pattern = $script:FactsSha256Pattern
    }
}

# $null when the four values have the form of the contract; otherwise the closed code of the first value that does not.
function Test-LauncherFactsValues {
    param($RunId, $RuntimeImageId, $AuditConfigSha256, $AuditConfigKind)
    if ($RunId -isnot [string] -or $RunId -cnotmatch $script:FactsRunIdPattern) { return 'run_id_invalid' }
    if ($RuntimeImageId -isnot [string] -or $RuntimeImageId -cnotmatch $script:FactsImageIdPattern -or $RuntimeImageId -ceq ('sha256:' + $script:FactsZeroSha256)) { return 'runtime_image_id_invalid' }
    if ($AuditConfigSha256 -isnot [string] -or $AuditConfigSha256 -cnotmatch $script:FactsSha256Pattern -or $AuditConfigSha256 -ceq $script:FactsZeroSha256) { return 'audit_config_sha256_invalid' }
    if ($AuditConfigKind -isnot [string] -or $script:LauncherFactsKinds -cnotcontains $AuditConfigKind) { return 'audit_config_kind_invalid' }
    $null
}

# Result: Ok, Code, Text, Bytes. Nothing is written.
function New-LauncherFactsText {
    [CmdletBinding()]
    param($RunId, $RuntimeImageId, $AuditConfigSha256, $AuditConfigKind)
    $bad = Test-LauncherFactsValues -RunId $RunId -RuntimeImageId $RuntimeImageId -AuditConfigSha256 $AuditConfigSha256 -AuditConfigKind $AuditConfigKind
    if ($null -ne $bad) { return [pscustomobject]@{ Ok = $false; Code = $bad; Text = $null; Bytes = $null } }
    $o = [ordered]@{
        schema_version = [long]$script:LauncherFactsSchemaVersion; issued_by = 'launcher'; run_id = $RunId; runtime_image_id = $RuntimeImageId
        audit_config_sha256 = $AuditConfigSha256; audit_config_kind = $AuditConfigKind
    }
    $text = ConvertTo-CanonicalJson -Value $o
    $bytes = $script:Utf8.GetBytes($text)
    if ($bytes.Length -gt $script:LauncherFactsMaxBytes) { return [pscustomobject]@{ Ok = $false; Code = 'facts_too_large'; Text = $null; Bytes = $null } }
    [pscustomobject]@{ Ok = $true; Code = $null; Text = $text; Bytes = $bytes }
}

# The checks of parseLauncherFactsText and createLauncherFactsSnapshot (launcherFacts.ts), in the same order and with the same code names.
# The expectations are optional here; when one is given it is checked first, as the TypeScript snapshot does. Result: Ok, Code, Values.
function Test-LauncherFactsText {
    [CmdletBinding()]
    param([AllowNull()]$Text, [string]$ExpectedRunId, [string]$ExpectedAuditConfigSha256)
    $r = { param($code, $values) [pscustomobject]@{ Ok = ($null -eq $code); Code = $code; Values = $values } }
    $hasRun = $PSBoundParameters.ContainsKey('ExpectedRunId')
    $hasSha = $PSBoundParameters.ContainsKey('ExpectedAuditConfigSha256')
    if ($hasRun -and ($ExpectedRunId -cnotmatch $script:FactsRunIdPattern)) { return (& $r 'expectation_run_id_invalid' $null) }
    if ($hasSha -and ($ExpectedAuditConfigSha256 -cnotmatch $script:FactsSha256Pattern -or $ExpectedAuditConfigSha256 -ceq $script:FactsZeroSha256)) { return (& $r 'expectation_audit_sha256_invalid' $null) }
    if ($Text -isnot [string]) { return (& $r 'facts_not_string' $null) }
    if ($script:Utf8.GetByteCount($Text) -gt $script:LauncherFactsMaxBytes) { return (& $r 'facts_too_large' $null) }
    $d = $null
    try { $d = ConvertFrom-JsonStrict -Text $Text } catch { return (& $r 'facts_invalid_json' $null) }
    if ($d -isnot [System.Collections.IDictionary]) { return (& $r 'facts_not_object' $null) }
    $own = @($d.Keys | ForEach-Object { [string]$_ })
    foreach ($k in $script:LauncherFactsKeys) { if ($own -cnotcontains $k) { return (& $r 'field_missing' $null) } }
    if ($own.Count -ne $script:LauncherFactsKeys.Count) { return (& $r 'field_unknown' $null) }
    $sv = $d['schema_version']
    if ($sv -isnot [long] -or $sv -ne $script:LauncherFactsSchemaVersion) { return (& $r 'schema_version_invalid' $null) }
    if ($d['issued_by'] -isnot [string] -or $d['issued_by'] -cne 'launcher') { return (& $r 'issued_by_invalid' $null) }
    $run = $d['run_id']; $img = $d['runtime_image_id']; $sha = $d['audit_config_sha256']; $kind = $d['audit_config_kind']
    if ($run -isnot [string] -or $run -cnotmatch $script:FactsRunIdPattern) { return (& $r 'run_id_invalid' $null) }
    if ($img -isnot [string] -or $img -cnotmatch $script:FactsImageIdPattern -or $img -ceq ('sha256:' + $script:FactsZeroSha256)) { return (& $r 'runtime_image_id_invalid' $null) }
    if ($sha -isnot [string] -or $sha -cnotmatch $script:FactsSha256Pattern -or $sha -ceq $script:FactsZeroSha256) { return (& $r 'audit_config_sha256_invalid' $null) }
    if ($kind -isnot [string] -or $script:LauncherFactsKinds -cnotcontains $kind) { return (& $r 'audit_config_kind_invalid' $null) }
    if ($hasRun -and $run -cne $ExpectedRunId) { return (& $r 'run_id_mismatch' $null) }
    if ($hasSha -and $sha -cne $ExpectedAuditConfigSha256) { return (& $r 'audit_config_sha256_mismatch' $null) }
    & $r $null ([pscustomobject]@{ RunId = $run; RuntimeImageId = $img; AuditConfigSha256 = $sha; AuditConfigKind = $kind })
}

# The bytes of a facts file: at most 4096 bytes, no byte-order mark, valid UTF-8, the checks of Test-LauncherFactsText, and EXACTLY the
# canonical text of the values (so no trailing line feed, no white space, no other key order). Result: Ok, Code, Values.
function Test-LauncherFactsBytes {
    [CmdletBinding()]
    param([AllowNull()][byte[]]$Bytes, [string]$ExpectedRunId, [string]$ExpectedAuditConfigSha256)
    $r = { param($code, $values) [pscustomobject]@{ Ok = ($null -eq $code); Code = $code; Values = $values } }
    if ($null -eq $Bytes) { return (& $r 'facts_read_absent' $null) }
    if ($Bytes.Length -gt $script:LauncherFactsMaxBytes) { return (& $r 'facts_too_large' $null) }
    if ($Bytes.Length -ge 3 -and $Bytes[0] -eq 0xEF -and $Bytes[1] -eq 0xBB -and $Bytes[2] -eq 0xBF) { return (& $r 'facts_bom' $null) }
    $text = $null
    try { $text = $script:FactsUtf8Strict.GetString($Bytes) } catch { return (& $r 'facts_not_utf8' $null) }
    $args2 = @{ Text = $text }
    if ($PSBoundParameters.ContainsKey('ExpectedRunId')) { $args2['ExpectedRunId'] = $ExpectedRunId }
    if ($PSBoundParameters.ContainsKey('ExpectedAuditConfigSha256')) { $args2['ExpectedAuditConfigSha256'] = $ExpectedAuditConfigSha256 }
    $t = Test-LauncherFactsText @args2
    if (-not $t.Ok) { return (& $r $t.Code $null) }
    $again = New-LauncherFactsText -RunId $t.Values.RunId -RuntimeImageId $t.Values.RuntimeImageId -AuditConfigSha256 $t.Values.AuditConfigSha256 -AuditConfigKind $t.Values.AuditConfigKind
    if (-not $again.Ok -or $again.Text -cne $text) { return (& $r 'facts_not_canonical' $null) }
    & $r $null $t.Values
}

# Creates a NEW file with exactly these bytes, or changes nothing that existed: (1) the target (file or directory) must not exist; (2)
# `<path>.tmp` is created with CreateNew and FileShare.None (an existing temporary file is refused and is NOT touched, because it is not ours);
# (3) the bytes are written and flushed to disk (Flush(true)); (4) the temporary file is moved to the target WITHOUT overwrite; (5) the target is
# read back and must equal the bytes. Only the temporary file that THIS call created is removed on a failure before the move. A target that was
# created and then fails the read-back is KEPT (Published = $true) and reported; the caller does not start the container. Result: Ok, Code, Published, Sha256.
function Write-FileExclusive {
    [CmdletBinding()]
    param([Parameter(Mandatory)][string]$Path, [Parameter(Mandatory)][AllowEmptyCollection()][byte[]]$Bytes)
    $res = { param($ok, $code, $published, $sha) [pscustomobject]@{ Ok = $ok; Code = $code; Published = $published; Sha256 = $sha } }
    $dir = [System.IO.Path]::GetDirectoryName($Path)
    if ([string]::IsNullOrEmpty($dir) -or -not [System.IO.Directory]::Exists($dir)) { return (& $res $false 'directory_invalid' $false $null) }
    if ([System.IO.File]::Exists($Path) -or [System.IO.Directory]::Exists($Path)) { return (& $res $false 'exists' $false $null) }
    $tmp = $Path + '.tmp'
    $created = $false
    $published = $false
    try {
        $fs = $null
        try { $fs = [System.IO.FileStream]::new($tmp, [System.IO.FileMode]::CreateNew, [System.IO.FileAccess]::Write, [System.IO.FileShare]::None) }
        catch { return (& $res $false 'tmp_not_created' $false $null) }
        $created = $true
        try { $fs.Write($Bytes, 0, $Bytes.Length); $fs.Flush($true) }
        catch { return (& $res $false 'write_failed' $false $null) }
        finally { $fs.Dispose() }
        try { Move-FileNoOverwrite -Source $tmp -Destination $Path }
        catch { return (& $res $false $(if ([System.IO.File]::Exists($Path)) { 'exists' } else { 'publish_failed' }) $false $null) }
        $published = $true
        $back = $null
        try { $back = [System.IO.File]::ReadAllBytes($Path) } catch { return (& $res $false 'readback_failed' $true $null) }
        if ($back.Length -ne $Bytes.Length -or -not [System.Linq.Enumerable]::SequenceEqual($back, $Bytes)) { return (& $res $false 'readback_failed' $true $null) }
        return (& $res $true $null $true (Get-Sha256Hex -Bytes $back))
    } finally {
        if ($created -and -not $published) { try { if ([System.IO.File]::Exists($tmp)) { [System.IO.File]::Delete($tmp) } } catch { } }
    }
}

# Generates, writes (exclusively), reads back, and verifies `<LeaseDir>/launcher-facts.json`. Nothing is written when a value is invalid.
# The caller starts the container only when Ok. Result: Ok, Code, Sha256 (of the file).
function Write-LauncherFactsFile {
    [CmdletBinding()]
    param([Parameter(Mandatory)][string]$LeaseDir, $RunId, $RuntimeImageId, $AuditConfigSha256, $AuditConfigKind)
    $t = New-LauncherFactsText -RunId $RunId -RuntimeImageId $RuntimeImageId -AuditConfigSha256 $AuditConfigSha256 -AuditConfigKind $AuditConfigKind
    if (-not $t.Ok) { return [pscustomobject]@{ Ok = $false; Code = $t.Code; Sha256 = $null } }
    $path = Join-Path $LeaseDir 'launcher-facts.json'
    $w = Write-FileExclusive -Path $path -Bytes $t.Bytes
    if (-not $w.Ok) { return [pscustomobject]@{ Ok = $false; Code = $w.Code; Sha256 = $null } }
    $back = $null
    try { $back = [System.IO.File]::ReadAllBytes($path) } catch { return [pscustomobject]@{ Ok = $false; Code = 'facts_verify_failed'; Sha256 = $null } }
    $v = Test-LauncherFactsBytes -Bytes $back -ExpectedRunId $RunId -ExpectedAuditConfigSha256 $AuditConfigSha256
    if (-not $v.Ok) { return [pscustomobject]@{ Ok = $false; Code = 'facts_verify_failed'; Sha256 = $null } }
    [pscustomobject]@{ Ok = $true; Code = $null; Sha256 = $w.Sha256 }
}
Export-ModuleMember -Function Get-LauncherConstants, Invoke-DockerCli, Set-DockerCliInvoker, Set-LauncherTimeHooks, Enter-RunLock, Enter-DiscoveryLocks, Exit-ConformanceMutex, Exit-RunLock, New-DiscoveryRunId, Test-RunIdFormat, Get-RunPaths, Test-RunIdFree, Write-TextAtomically, Get-AtomicReplaceSettings, Get-LastAtomicReplace, Test-TransientReplaceDenial, Write-ReasonFile, New-LeaseNonce, New-RunLease, Step-LeaseHeartbeat, Revoke-RunLease, Stop-LeftoverRuntimeContainers, Test-ContainerRunning, Stop-ContainerConfirmed, Set-InterruptedRuns, Get-ContainerName, New-ContainerCreateArgs, Get-ExpectedMountTargets, Get-MountInspection, Test-LaunchGate, Invoke-RunExport, Invoke-VolumeOwnerHelper, Get-VolumeKind, Get-RunVolumes, Write-LauncherRecord, Wait-RuntimeContainer, ConvertTo-FlatList, Test-EvidenceSaved, Remove-OwnRunContainer, Invoke-DiscoveryStart, Get-LauncherFactsContract, Test-LauncherFactsValues, New-LauncherFactsText, Test-LauncherFactsText, Test-LauncherFactsBytes, Write-FileExclusive, Write-LauncherFactsFile, Invoke-BoundedProcess, Invoke-DockerCliCapture, Test-PropagationDelayValue, Get-CreatedContainerImage, ConvertTo-RuntimeReportRecord, Get-RuntimeExitReport, Get-ReasonSummary, Get-RunOutcome, Test-UnstoppedRunRetained, Get-UnstoppedRunRetainedCount, Remove-RunVolume, Get-VolumeKeepReason, Get-VolumeKeepReasons, Test-RunNormalEnd, Test-ExportFinalVerified, Test-RunVolumeIdentity, Test-LauncherRunSeconds, Get-LauncherRunLimitMs, Get-LauncherRunConfigLimit
