#Requires -Version 7.0
# Launcher tests (tasks 2.18, 2.21, 2.22, 2.23) with the fake container CLI, temporary directories, and TEST-SPECIFIC mutex names.
# No real daemon, no real conformance mutex, no Legacy_App, no network. A temporary repository root replaces the real one, so nothing
# under the real discovery/ is read or written.
. (Join-Path $PSScriptRoot 'lib/testlib.ps1')
. (Join-Path $PSScriptRoot 'lib/fakeDocker.ps1')
Import-Module (Join-Path $script:ToolsDir 'DiscoveryCommon.psm1') -Force -DisableNameChecking
Import-Module (Join-Path $script:ToolsDir 'LeaseTiming.psm1') -Force -DisableNameChecking
Import-Module (Join-Path $script:ToolsDir 'ApprovalStore.psm1') -Force -DisableNameChecking
Import-Module (Join-Path $script:ToolsDir 'DiscoveryLauncher.psm1') -Force -DisableNameChecking

$utf8 = [System.Text.UTF8Encoding]::new($false)
$entry = Join-Path $script:ToolsDir 'Start-DiscoveryRun.ps1'
$realMutex = 'Local\ProjectPhoenixGroundTruthEvaluation'
function New-TestMutexName { 'Local\PhoenixTest-Launcher-' + [guid]::NewGuid().ToString('N') }
$quiet = { param($m) }

# A temporary repository root with an approved override-apply (temporary store) and a valid lease-timing record (synthetic numbers).
function New-TestRepo {
    param([switch]$NoApproval, [switch]$NoTiming, [long]$D = 100)
    $root = New-TempDir
    [void][IO.Directory]::CreateDirectory((Join-Path $root 'discovery/approvals'))
    [void][IO.Directory]::CreateDirectory((Join-Path $root 'discovery/config'))
    [void][IO.Directory]::CreateDirectory((Join-Path $root 'packages'))
    $store = Join-Path $root 'discovery/approvals/approvals.jsonl'
    if (-not $NoApproval) {
        $c = [ordered]@{ approver = 'Test Approver'; timestamp = '2026-01-01T00:00:00.000+09:00'; target = [ordered]@{ kind = 'gate'; gate_id = 'override-apply' }; decision = 'approved'; rationale = 'Test only.'; recorded_by = 'human' }
        $r = Invoke-ApprovalStoreRequest -StorePath $store -Request ([ordered]@{ operation = 'append'; candidate = $c }) -MutexName (New-TestMutexName)
        if ($r.Outcome -ne 'stored') { throw "test approval not stored: $($r.Outcome)" }
    }
    if (-not $NoTiming) { Write-TimingRecord -Path (Join-Path $root 'discovery/config/lease-timing.json') -D $D }
    $root
}

function Write-TimingRecord {
    param([string]$Path, [long]$D = 100, [int]$Beats = 300, [int]$Healthy = 10, [int]$Stopped = 5, [long[]]$Kill = @(5000) * 10, [string]$Server = '29.0.0-test', $Settings = (Get-LeaseSettings))
    $rt = [long[]]@(1..$Beats | ForEach-Object { if ($_ -eq 1) { $D } else { [Math]::Min($D, 10) } })
    $rec = New-LeaseTimingRecord -Settings $Settings -MeasuredAt '2026-01-01T00:00:00.000+09:00' -Docker ([pscustomobject]@{ serverVersion = $Server; os = 'test'; osType = 'linux'; kernelVersion = 'test'; architecture = 'amd64' }) `
        -ProbeImageDigest ('sha256:' + ('1' * 64)) -LeaseMount 'bind' -RoundTripsMs $rt -GapsMs @(1000) -HealthyTrials $Healthy -HealthyPassed $Healthy -StoppedTrials $Stopped -StoppedRefused $Stopped -StoppedRequests 0 -KillSamplesMs $Kill
    [IO.File]::WriteAllText($Path, (ConvertTo-CanonicalJson -Value $rec) + "`n", $utf8)
}

function Install-Fake {
    param([string]$Root)
    $fake = New-FakeDocker -Root $Root
    Set-DockerCliInvoker -Invoker $fake.Invoker
    $script:fakeNow = 0L
    Set-LauncherTimeHooks -NowMs { $script:fakeNow } -SleepMs { param($ms) $script:fakeNow += $ms }
    $fake
}

function Start-Test {
    param([string]$Root, [string]$Profile = 'run', [string]$MutexName = (New-TestMutexName))
    Invoke-DiscoveryStart -RepoRoot $Root -Profile $Profile -MutexName $MutexName -LockPath (Join-Path $Root 'discovery/locks/discovery-run.lock') -Log $quiet
}

function Get-SideEffects {
    param($Fake, [string]$Root)
    [pscustomobject]@{
        VolumeCreate = @($Fake.State.Calls | Where-Object { $_ -like 'volume create*' }).Count
        Create = @($Fake.State.Calls | Where-Object { $_ -like 'create *' }).Count
        Start = @($Fake.State.Calls | Where-Object { $_ -like 'start *' }).Count
        Leases = Test-Path -LiteralPath (Join-Path $Root 'discovery/leases')
        Runs = Test-Path -LiteralPath (Join-Path $Root 'discovery/runs')
    }
}
function Test-NoSideEffects { param($Fx) $Fx.VolumeCreate -eq 0 -and $Fx.Create -eq 0 -and $Fx.Start -eq 0 -and -not $Fx.Leases -and -not $Fx.Runs }

Invoke-TestMain {
    Write-Host '=== Launcher (tasks 2.18, 2.21, 2.22, 2.23) ===' -ForegroundColor Cyan

    # ---------------------------------------------------------------- static checks of the entry point and the tools
    $tokens = $null; $errors = $null
    $ast = [System.Management.Automation.Language.Parser]::ParseFile($entry, [ref]$tokens, [ref]$errors)
    $params = @($ast.ParamBlock.Parameters | ForEach-Object { $_.Name.VariablePath.UserPath })
    $entryText = Get-Content -Raw -LiteralPath $entry
    Test-Case 'static: the entry point declares only -Probe (no parameter for the mutex name or the lock path)' (($params -join ',') -ceq 'Probe' -and $errors.Count -eq 0) ($params -join ',')
    Test-Case 'static: the entry point contains the exact mutex constant and the exact lock path' ($entryText.Contains("-MutexName '$realMutex'") -and $entryText.Contains("'discovery/locks/discovery-run.lock'"))
    Test-Case 'static: the entry point reads no environment variable and installs no test hook' (-not ($entryText -match '\$env:|Set-DockerCliInvoker|Set-LauncherTimeHooks'))
    $toolText = @{}; foreach ($t in Get-ChildItem -LiteralPath $script:ToolsDir -File -Include *.ps1, *.psm1 -Recurse) { $toolText[$t.Name] = Get-Content -Raw -LiteralPath $t.FullName }
    $spawners = @($toolText.Keys | Where-Object { $toolText[$_] -match "ProcessStartInfo\]::new\('dock" -or $toolText[$_] -match '(^|\s)&\s*dock' -or $toolText[$_] -match 'Start-Process\s+dock' })
    Test-Case 'static: only DiscoveryLauncher.psm1 starts the container CLI (Invoke-DockerCli is the one entry point)' (($spawners -join ',') -ceq 'DiscoveryLauncher.psm1') ($spawners -join ',')
    $from = (Get-Content -LiteralPath (Join-Path $script:RepoRoot 'infra/discovery/toolchain.Dockerfile') | Where-Object { $_ -match '^FROM ' } | Select-Object -First 1).Substring(5).Trim()
    Test-Case 'static: the export helper image is the pinned base image of the toolchain Dockerfile' ((Get-LauncherConstants).HelperImage -ceq $from) $from
    Test-Case 'static: the scope note is in the script header and in the module, and names one host and one logon session' ($entryText -match 'one host and one Windows logon session only' -and $toolText['DiscoveryLauncher.psm1'] -match 'ONE HOST AND ONE\s+# WINDOWS LOGON SESSION ONLY|ONE HOST AND ONE')
    $approvalUsers = @($toolText.Keys | Where-Object { $_ -ne 'ApprovalStore.psm1' -and $_ -ne 'Add-ApprovalRecord.ps1' -and $toolText[$_] -match 'Invoke-ApprovalStoreRequest' })
    Test-Case 'static: no Launcher or measurement tool writes the Approval_Store (they only read the Gate status)' ($approvalUsers.Count -eq 0 -and $toolText['DiscoveryLauncher.psm1'] -match 'Get-ApprovalGateStatus') ($approvalUsers -join ',')
    Test-Case 'static: this test file passes no real mutex name to Enter-DiscoveryLocks or Invoke-DiscoveryStart' (-not ((Get-Content -Raw -LiteralPath $PSCommandPath) -match "-MutexName\s+'Local\\ProjectPhoenixGroundTruthEvaluation'"))

    # ---------------------------------------------------------------- Run identifier
    $ids = @(1..200 | ForEach-Object { New-DiscoveryRunId })
    Test-Case 'Run ID: UTC date and time plus 12 hexadecimal digits, and 200 identifiers are distinct' ((@($ids | Where-Object { -not (Test-RunIdFormat $_) }).Count -eq 0) -and (@($ids | Select-Object -Unique).Count -eq 200)) $ids[0]
    Test-Case 'Run ID: matches the RunId pattern of the approval schema and the volume name rules' ($ids[0] -cmatch '^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$' -and ("phoenix-run-" + $ids[0]) -cmatch '^[a-zA-Z0-9][a-zA-Z0-9_.-]+$')
    Test-Case 'Run ID: the random part comes from the cryptographic generator' ($toolText['DiscoveryLauncher.psm1'] -match 'RandomNumberGenerator\]::Fill' -and -not ($toolText['DiscoveryLauncher.psm1'] -match 'Get-Random'))
    $root = New-TestRepo
    $fake = Install-Fake $root
    $id = New-DiscoveryRunId
    $p = Get-RunPaths -RepoRoot $root -RunId $id
    Test-Case 'Run ID: free when nothing of that name exists' (Test-RunIdFree -RepoRoot $root -RunId $id).Free
    $fake.State.Volumes[$p.Volume] = (New-TempDir)
    [void][IO.Directory]::CreateDirectory($p.Final); [void][IO.Directory]::CreateDirectory($p.Export); [void][IO.Directory]::CreateDirectory($p.Lease)
    $taken = Test-RunIdFree -RepoRoot $root -RunId $id
    Test-Case 'Run ID: a Run_Volume, a Run directory, an Incoming_Export, and a lease directory of the same name each make it taken' (-not $taken.Free -and (($taken.Taken -join ',') -ceq 'run_volume,run_directory,incoming_export,lease_directory')) ($taken.Taken -join ',')
    $sentinel = Join-Path $p.Export 'keep.txt'; [IO.File]::WriteAllText($sentinel, 'existing')
    $ex = Invoke-RunExport -RepoRoot $root -RunId $id
    Test-Case 'collision: an existing Incoming_Export refuses the export (create_export) and is left unchanged' ($ex.Outcome -eq 'incomplete' -and $ex.Step -eq 'create_export' -and ([IO.File]::ReadAllText($sentinel) -eq 'existing') -and @(Get-ChildItem -LiteralPath $p.Export).Count -eq 1)

    # ---------------------------------------------------------------- locks
    $lockRoot = New-TempDir
    $lockPath = Join-Path $lockRoot 'locks/discovery-run.lock'
    $m = New-TestMutexName
    $l1 = Enter-DiscoveryLocks -MutexName $m -LockPath $lockPath
    $l2 = Enter-DiscoveryLocks -MutexName (New-TestMutexName) -LockPath $lockPath
    Test-Case 'locks: a second start while the Run lock is held reports run_lock' ($l1.Ok -and -not $l2.Ok -and $l2.Code -eq 'run_lock')
    Exit-ConformanceMutex $l1; Exit-RunLock $l1
    $l3 = Enter-DiscoveryLocks -MutexName $m -LockPath $lockPath
    Test-Case 'locks: both locks can be taken again after they were released' $l3.Ok
    Exit-ConformanceMutex $l3; Exit-RunLock $l3

    $held = New-TestMutexName
    $flag = Join-Path $lockRoot 'held.flag'
    $holder = Join-Path $lockRoot 'holder.ps1'
    [IO.File]::WriteAllText($holder, "`$m = [System.Threading.Mutex]::new(`$false, '$held'); [void]`$m.WaitOne(); [IO.File]::WriteAllText('$flag', 'x'); Start-Sleep -Seconds 30")
    $proc = Start-Process -FilePath (Get-Process -Id $PID).Path -ArgumentList @('-NoProfile', '-NonInteractive', '-File', $holder) -PassThru -WindowStyle Hidden
    try {
        $ready = $false; for ($i = 0; $i -lt 100 -and -not $ready; $i++) { Start-Sleep -Milliseconds 100; $ready = Test-Path -LiteralPath $flag }
        $l4 = Enter-DiscoveryLocks -MutexName $held -LockPath $lockPath
        Test-Case 'locks: a mutex held by another process (the conformance runner side) reports conformance_mutex and leaves the Run lock free' ($ready -and -not $l4.Ok -and $l4.Code -eq 'conformance_mutex' -and $null -ne ($s = Enter-RunLock -LockPath $lockPath))
        if ($s) { $s.Dispose() }
    } finally { try { $proc.Kill($true) } catch { }; $proc.WaitForExit() }

    # A helper that takes the test mutex and ends without releasing it. Abandonment is visible only while another handle to the
    # named mutex is open: once the last handle closes, Windows destroys the mutex and the next open gets a fresh one (observed
    # 2026-11-12 with a helper process; recorded in the design, OD-11).
    function New-AbandonedMutex {
        param([string]$Name)
        # A dedicated thread that takes the mutex and exits (Join), while this process keeps a handle open. A thread-pool thread
        # (Start-ThreadJob) can stay alive after the job ends, and a mutex with no open handle left is destroyed instead of abandoned.
        if (-not ('PhoenixTestAbandon' -as [type])) {
            Add-Type -TypeDefinition @"
using System.Threading;
public static class PhoenixTestAbandon {
    // The Mutex objects are kept so that a handle stays open: when the last handle closes (for example when the garbage collector
    // finalizes the object) the named mutex is destroyed, and the next open creates a fresh, unowned one.
    private static readonly System.Collections.Generic.List<Mutex> Kept = new System.Collections.Generic.List<Mutex>();
    public static bool Take(string name) {
        bool taken = false;
        var t = new Thread(() => { var m = new Mutex(false, name); lock (Kept) { Kept.Add(m); } taken = m.WaitOne(0); });
        t.Start(); t.Join();
        return taken;
    }
}
"@
        }
        [PhoenixTestAbandon]::Take($Name)
    }
    $ab = New-TestMutexName
    $taken = New-AbandonedMutex -Name $ab
    $l5 = Enter-DiscoveryLocks -MutexName $ab -LockPath $lockPath
    $after = Enter-DiscoveryLocks -MutexName $ab -LockPath $lockPath
    Test-Case 'abandoned: a mutex abandoned by its owner gives conformance_mutex_abandoned, and both locks are released' ($taken -and -not $l5.Ok -and $l5.Code -eq 'conformance_mutex_abandoned' -and $after.Ok)
    Exit-ConformanceMutex $after; Exit-RunLock $after

    # through the whole start: an abandoned mutex creates no volume, no lease, no container
    $root = New-TestRepo
    $fake = Install-Fake $root
    $ab2 = New-TestMutexName
    [void](New-AbandonedMutex -Name $ab2)
    $res = Start-Test -Root $root -MutexName $ab2
    Test-Case 'abandoned (start): exit non-zero, conformance_mutex_abandoned, no Run_Volume, no lease, no container' ($res.ExitCode -ne 0 -and $res.Code -eq 'conformance_mutex_abandoned' -and (Test-NoSideEffects (Get-SideEffects $fake $root))) ("exit=$($res.ExitCode) code=$($res.Code)")
    $next = Start-Test -Root $root -MutexName $ab2
    Test-Case 'abandoned (start): the following explicit start proceeds normally' ($next.Code -eq 'complete' -or $next.ExitCode -le 1) $next.Code

    # ---------------------------------------------------------------- the start gate (no side effect on refusal)
    $gateCases = @(
        @{ Name = 'no override-apply approval'; Repo = { New-TestRepo -NoApproval }; Code = 'override_apply_not_approved' },
        @{ Name = 'no lease-timing record'; Repo = { New-TestRepo -NoTiming }; Code = 'lease_timing_unmeasured' },
        @{ Name = 'a record that is not JSON'; Repo = { $r = New-TestRepo; [IO.File]::WriteAllText((Join-Path $r 'discovery/config/lease-timing.json'), 'not json'); $r }; Code = 'lease_timing_unmeasured' },
        @{ Name = 'a settings hash that differs'; Repo = { $r = New-TestRepo; Write-TimingRecord -Path (Join-Path $r 'discovery/config/lease-timing.json') -Settings ([ordered]@{ heartbeatIntervalMs = 1000; staleAfterMs = 5000 }); $r }; Code = 'lease_timing_unmeasured' },
        @{ Name = 'a server version that differs'; Repo = { $r = New-TestRepo; Write-TimingRecord -Path (Join-Path $r 'discovery/config/lease-timing.json') -Server '28.0.0'; $r }; Code = 'lease_timing_unmeasured' },
        @{ Name = 'too few beats'; Repo = { $r = New-TestRepo; Write-TimingRecord -Path (Join-Path $r 'discovery/config/lease-timing.json') -Beats 299; $r }; Code = 'lease_timing_unmeasured' },
        @{ Name = 'too few healthy trials'; Repo = { $r = New-TestRepo; Write-TimingRecord -Path (Join-Path $r 'discovery/config/lease-timing.json') -Healthy 9; $r }; Code = 'lease_timing_unmeasured' },
        @{ Name = 'too few stopped-writer trials'; Repo = { $r = New-TestRepo; Write-TimingRecord -Path (Join-Path $r 'discovery/config/lease-timing.json') -Stopped 4; $r }; Code = 'lease_timing_unmeasured' },
        @{ Name = 'too few kill samples'; Repo = { $r = New-TestRepo; Write-TimingRecord -Path (Join-Path $r 'discovery/config/lease-timing.json') -Kill (@(5000) * 9); $r }; Code = 'lease_timing_unmeasured' },
        @{ Name = 'a kill sample above 10000 ms'; Repo = { $r = New-TestRepo; Write-TimingRecord -Path (Join-Path $r 'discovery/config/lease-timing.json') -Kill (@(5000) * 9 + @(10001)); $r }; Code = 'lease_timing_unmeasured' },
        @{ Name = 'a rule that fails with the measured D'; Repo = { New-TestRepo -D 1751 }; Code = 'lease_timing_invalid' }
    )
    foreach ($gc in $gateCases) {
        $root = & $gc.Repo
        $fake = Install-Fake $root
        $res = Start-Test -Root $root
        Test-Case "gate: $($gc.Name) gives $($gc.Code), a non-zero exit, and no Run_Volume, Run directory, lease, or container" ($res.ExitCode -ne 0 -and $res.Code -eq $gc.Code -and (Test-NoSideEffects (Get-SideEffects $fake $root))) "code=$($res.Code)"
    }
    $root = New-TestRepo
    $fake = Install-Fake $root
    $fake.State.Images.Remove('phoenix/discovery-runtime:m4')
    $res = Start-Test -Root $root
    Test-Case 'gate: a missing runtime image refuses a Run (the probe image is not used instead)' ($res.Code -eq 'runtime_image_missing' -and (Test-NoSideEffects (Get-SideEffects $fake $root)))
    $root = New-TestRepo
    $fake = Install-Fake $root
    [IO.File]::WriteAllText((Join-Path $root 'discovery/approvals/approvals.jsonl'), ([IO.File]::ReadAllText((Join-Path $root 'discovery/approvals/approvals.jsonl'))).Replace('Test only.', 'Edited.'), $utf8)
    $res = Start-Test -Root $root
    Test-Case 'gate: a tampered Approval_Store means no approval' ($res.Code -eq 'override_apply_not_approved' -and (Test-NoSideEffects (Get-SideEffects $fake $root)))
    $root = New-TestRepo
    $fake = Install-Fake $root
    $res = Start-Test -Root $root
    $lockedAgain = Enter-RunLock -LockPath (Join-Path $root 'discovery/locks/discovery-run.lock')
    Test-Case 'a valid record lets the start proceed and its hash is in the Launcher record' ($null -ne $res.RunId -and ((Get-Content -Raw (Get-ChildItem -LiteralPath (Join-Path $root 'discovery/runs') -Recurse -Filter '*.launcher.json' | Select-Object -First 1).FullName) -match [regex]::Escape((Get-Sha256HexOfFile -Path (Join-Path $root 'discovery/config/lease-timing.json')))))
    if ($lockedAgain) { $lockedAgain.Dispose() }

    # ---------------------------------------------------------------- a complete Run (fake runtime writes a sealed Run)
    $root = New-TestRepo
    $fake = Install-Fake $root
    $fake.State.OnStart = { param($name, $s) $c = $s.Containers[$name]; $vol = ($c.Mounts | Where-Object { $_.Destination -eq '/run/out' }).Source; [void](New-TestSealedRun -Dir $s.Volumes[$vol]) }
    $res = Start-Test -Root $root
    $p = Get-RunPaths -RepoRoot $root -RunId $res.RunId
    $rec = ConvertFrom-JsonStrict -Text ([IO.File]::ReadAllText((Join-Path $p.Runs "$($res.RunId).launcher.json")))
    Test-Case 'run: exit 0, complete, and every reader accepts the final Run directory' ($res.ExitCode -eq 0 -and $res.Code -eq 'complete' -and (Test-CompletedRun -Path $p.Final)) "code=$($res.Code)"
    Test-Case 'run: COMPLETE holds the SHA-256 of manifest.json and is the last file written into the export' (([IO.File]::ReadAllText((Join-Path $p.Final 'COMPLETE'))) -ceq (Get-Sha256HexOfFile -Path (Join-Path $p.Final 'manifest.json')))
    Test-Case 'run: the volume is removed only after the verified export, and the Launcher record says so' (-not $fake.State.Volumes.ContainsKey($p.Volume) -and $rec['volumeDisposition'] -ceq 'removed_after_verified_export' -and $rec['export']['outcome'] -ceq 'complete')
    $leaseJson = ConvertFrom-JsonStrict -Text ([IO.File]::ReadAllText((Join-Path $p.Lease 'lease.json')))
    Test-Case 'run: the lease carries the fields of the design, H and S included; at the end revoked exists and heartbeat is removed; the directory is kept' (
        $leaseJson['run_id'] -ceq $res.RunId -and $leaseJson['issued_by'] -ceq 'launcher' -and $leaseJson['heartbeat_interval_ms'] -eq 1000 -and $leaseJson['stale_after_ms'] -eq 4000 -and $leaseJson['nonce_sha256'] -cmatch '^[0-9a-f]{64}$' -and
        (Test-Path -LiteralPath (Join-Path $p.Lease 'revoked')) -and -not (Test-Path -LiteralPath (Join-Path $p.Lease 'heartbeat')))
    $att = ConvertFrom-JsonStrict -Text ([IO.File]::ReadAllText((Join-Path $p.Lease 'isolation-attestation.json')))
    Test-Case 'run: the mount_inspection attestation is written into the lease directory before the start, and it is ok' ($att['check'] -ceq 'mount_inspection' -and $att['ok'] -eq $true)
    $calls = @($fake.State.Calls)
    $iRecover = [Array]::FindIndex([string[]]$calls, [Predicate[string]]{ param($c) $c -like 'ps -a -q*' })
    $iVolume = [Array]::FindIndex([string[]]$calls, [Predicate[string]]{ param($c) $c -like 'volume create*' })
    $iCreate = [Array]::FindIndex([string[]]$calls, [Predicate[string]]{ param($c) $c -like 'create *' })
    $iStart = [Array]::FindIndex([string[]]$calls, [Predicate[string]]{ param($c) $c -like 'start *' })
    $iHelper = [Array]::FindIndex([string[]]$calls, [Predicate[string]]{ param($c) $c -like '*export-helper*' })
    $iRm = [Array]::FindIndex([string[]]$calls, [Predicate[string]]{ param($c) $c -like 'volume rm*' })
    Test-Case 'run: the order is recovery, volume, create, start, export copy, volume removal' ($iRecover -ge 0 -and $iRecover -lt $iVolume -and $iVolume -lt $iCreate -and $iCreate -lt $iStart -and $iStart -lt $iHelper -and $iHelper -lt $iRm) "$iRecover $iVolume $iCreate $iStart $iHelper $iRm"
    $createArgs = ($calls | Where-Object { $_ -like 'create *' } | Select-Object -First 1)
    Test-Case 'run: the container is created with the lab network only, read-only, no capability, non-root, the runtime labels, and no published port' ($createArgs -match '--network phoenix-discovery-lab' -and $createArgs -match '--read-only' -and $createArgs -match '--cap-drop ALL' -and $createArgs -match '--user 10001:10001' -and $createArgs -match 'phoenix.discovery.role=runtime' -and -not ($createArgs -match ' -p | --publish'))
    Test-Case 'run: the export helper has no network, is read-only, non-root, has no capability, and mounts the volume read-only' (($calls[$iHelper]) -match '--network none' -and $calls[$iHelper] -match '--read-only' -and $calls[$iHelper] -match '--cap-drop ALL' -and $calls[$iHelper] -match 'target=/src,readonly')
    Test-Case 'run: the heartbeat was renewed while the container ran, with no late beat' ($rec['heartbeats'] -ge 2 -and $rec['lateHeartbeats'] -eq 0) "beats=$($rec['heartbeats'])"
    $again = Enter-DiscoveryLocks -MutexName (New-TestMutexName) -LockPath (Join-Path $root 'discovery/locks/discovery-run.lock')
    Test-Case 'run: the Run lock is released after the export' $again.Ok
    Exit-ConformanceMutex $again; Exit-RunLock $again

    # the probe profile: not a Run; no manifest, so the export is incomplete and the volume kept
    $root = New-TestRepo
    $fake = Install-Fake $root
    $fake.State.OnStart = { param($name, $s) $c = $s.Containers[$name]; $vol = ($c.Mounts | Where-Object { $_.Destination -eq '/run/out' }).Source; [IO.File]::WriteAllText((Join-Path $s.Volumes[$vol] 'probe-result.json'), '{"ok":true}') }
    $res = Start-Test -Root $root -Profile 'probe'
    $p = Get-RunPaths -RepoRoot $root -RunId $res.RunId
    $rec = ConvertFrom-JsonStrict -Text ([IO.File]::ReadAllText((Join-Path $p.Incoming "$($res.RunId).launcher.json")))
    $createArgs = (@($fake.State.Calls) | Where-Object { $_ -like 'create *' } | Select-Object -First 1)
    Test-Case 'probe: started with the toolchain image, the probe label, the packages read-only, and the lease read-only' ($createArgs -match 'phoenix/discovery-toolchain:m0' -and $createArgs -match 'phoenix.discovery.start=probe' -and $createArgs -match 'target=/workspace/packages,readonly' -and $createArgs -match 'target=/run/lease,readonly')
    Test-Case 'probe: the Launcher record marks the start probe and names the image digest; the export is incomplete (no Run_Manifest); the volume is kept' ($rec['start'] -ceq 'probe' -and $rec['imageDigest'] -ceq ('sha256:' + ('1' * 64)) -and $rec['export']['step'] -ceq 'verify' -and $rec['volumeDisposition'] -ceq 'kept_for_diagnosis' -and $fake.State.Volumes.ContainsKey($p.Volume) -and -not (Test-CompletedRun -Path $p.Export))
    Test-Case 'probe: the probe is refused as a Run: the Run profile never uses the toolchain image' (-not ((New-ContainerCreateArgs -Profile 'run' -RepoRoot $root -RunId 'run-x' -Nonce 'n' -PropagationDelayMs 1) -contains 'phoenix/discovery-toolchain:m0'))

    # ---------------------------------------------------------------- mount inspection and recovery
    $root = New-TestRepo
    $fake = Install-Fake $root
    $fake.State.ExtraMount = [ordered]@{ Type = 'bind'; Source = '/var/run/docker.sock'; Destination = '/var/run/docker.sock'; RW = $true }
    $res = Start-Test -Root $root
    $p = Get-RunPaths -RepoRoot $root -RunId $res.RunId
    Test-Case 'inspection: an extra mount refuses the start before the container starts; the lease is revoked; the locks are released' ($res.Code -eq 'mount_inspection_failed' -and @($fake.State.Calls | Where-Object { $_ -like 'start *' }).Count -eq 0 -and (Test-Path -LiteralPath (Join-Path $p.Lease 'revoked')) -and (Enter-RunLock -LockPath (Join-Path $root 'discovery/locks/discovery-run.lock')))
    $root = New-TestRepo
    $fake = Install-Fake $root
    $fake.State.ExtraNetwork = 'legacy-api'
    $res = Start-Test -Root $root
    Test-Case 'inspection: a second network refuses the start' ($res.Code -eq 'mount_inspection_failed')

    $root = New-TestRepo
    $fake = Install-Fake $root
    $fake.State.Containers['leftover'] = @{ Running = $true; ExitCode = '0'; Labels = @{ 'phoenix.discovery.role' = 'runtime' }; Mounts = @(); Networks = @(); Polls = $null }
    $oldId = 'run-20250101T000000Z-aaaaaaaaaaaa'
    $fake.State.Volumes["phoenix-run-$oldId"] = (New-TempDir)
    $fake.State.OnStart = { param($name, $s) $c = $s.Containers[$name]; $vol = ($c.Mounts | Where-Object { $_.Destination -eq '/run/out' }).Source; [void](New-TestSealedRun -Dir $s.Volumes[$vol]) }
    $res = Start-Test -Root $root
    $calls = @($fake.State.Calls)
    $iStop = [Array]::FindIndex([string[]]$calls, [Predicate[string]]{ param($c) $c -like 'stop * leftover' })
    $iVolume = [Array]::FindIndex([string[]]$calls, [Predicate[string]]{ param($c) $c -like 'volume create*' })
    $reason = Join-Path $root "discovery/runs/.incoming/$oldId/REASON.json"
    Test-Case 'recovery: a leftover runtime container is stopped (after the locks, before the new volume) and confirmed' ($iStop -ge 0 -and $iStop -lt $iVolume -and -not $fake.State.Containers['leftover'].Running)
    Test-Case 'recovery: an earlier Run_Volume without a verified export gets a Reason_File interrupted, keeps its volume, and gets no marker' ((Test-Path -LiteralPath $reason) -and (ConvertFrom-JsonStrict -Text ([IO.File]::ReadAllText($reason)))['step'] -ceq 'interrupted' -and $fake.State.Volumes.ContainsKey("phoenix-run-$oldId") -and -not (Test-Path -LiteralPath (Join-Path $root "discovery/runs/.incoming/$oldId/COMPLETE")))
    $root = New-TestRepo
    $fake = Install-Fake $root
    $fake.State.Containers['leftover'] = @{ Running = $true; ExitCode = '0'; Labels = @{ 'phoenix.discovery.role' = 'runtime' }; Mounts = @(); Networks = @(); Polls = $null }
    $fake.State.StopFails = $true
    $res = Start-Test -Root $root
    Test-Case 'recovery: a leftover that cannot be stopped refuses the start; no new volume and no lease are created' ($res.Code -eq 'recovery_failed' -and @($fake.State.Calls | Where-Object { $_ -like 'volume create*' }).Count -eq 0 -and -not (Test-Path -LiteralPath (Join-Path $root 'discovery/leases')))

    # ---------------------------------------------------------------- the volume owner helper (CHOWN)
    $root = New-TestRepo
    $fake = Install-Fake $root
    $fake.State.FailOwner = $true
    $res = Start-Test -Root $root
    $calls = @($fake.State.Calls)
    $pO = Get-RunPaths -RepoRoot $root -RunId $res.RunId
    $reasonO = Join-Path $pO.Export 'REASON.json'
    $recO = if (Test-Path -LiteralPath (Join-Path $pO.Incoming "$($res.RunId).launcher.json")) { ConvertFrom-JsonStrict -Text ([IO.File]::ReadAllText((Join-Path $pO.Incoming "$($res.RunId).launcher.json"))) } else { $null }
    Test-Case 'owner helper: a non-zero exit stops the start (exit 3, volume_owner_failed) before the lease and the container' ($res.ExitCode -eq 3 -and $res.Code -eq 'volume_owner_failed' -and -not (Test-Path -LiteralPath $pO.Lease) -and @($calls | Where-Object { $_ -like 'create *' -or $_ -like 'start *' }).Count -eq 0) "exit=$($res.ExitCode) code=$($res.Code)"
    Test-Case 'owner helper: the cause is in a Reason_File volume_owner and in the Launcher record; the empty volume is kept (no removal)' ((Test-Path -LiteralPath $reasonO) -and (ConvertFrom-JsonStrict -Text ([IO.File]::ReadAllText($reasonO)))['step'] -ceq 'volume_owner' -and ([IO.File]::ReadAllText($reasonO)).Contains('Operation not permitted') -and $null -ne $recO -and $recO['volumeOwner']['exitCode'] -eq 1 -and $recO['volumeOwner']['detail'] -like '*Operation not permitted*' -and $fake.State.Volumes.ContainsKey($pO.Volume) -and @($calls | Where-Object { $_ -like 'volume rm *' }).Count -eq 0)
    $again = Enter-RunLock -LockPath (Join-Path $root 'discovery/locks/discovery-run.lock')
    Test-Case 'owner helper: after the failure both locks are released' ($null -ne $again); if ($again) { $again.Dispose() }
    $fake.State.FailOwner = $false
    [void](Start-Test -Root $root)
    Test-Case 'owner helper: the next start keeps the volume_owner Reason_File (recovery does not overwrite it)' ((ConvertFrom-JsonStrict -Text ([IO.File]::ReadAllText($reasonO)))['step'] -ceq 'volume_owner')
    $ownerCall = @($calls | Where-Object { $_ -like '*phoenix.discovery.role=volume-owner*' })[0]
    $capAdds = [regex]::Matches($ownerCall, '--cap-add (\S+)') | ForEach-Object { $_.Groups[1].Value }
    Test-Case 'owner helper: privileges are not widened: uid 0 with only CAP_CHOWN after --cap-drop ALL, no new privileges, no network, read-only, limits, only the new volume, owner of the root only, result checked' ($ownerCall -match '--cap-drop ALL' -and (@($capAdds) -join ',') -ceq 'CHOWN' -and $ownerCall -match 'no-new-privileges:true' -and $ownerCall -match '--network none' -and $ownerCall -match '--read-only' -and $ownerCall -match '--pids-limit' -and $ownerCall -match '--memory' -and @([regex]::Matches($ownerCall, '--mount ')).Count -eq 1 -and $ownerCall -match 'target=/v' -and -not ($ownerCall -match 'chown -R') -and $ownerCall -match 'stat -c %u:%g /v' -and -not ($ownerCall -match '--privileged'))
    $launcherSrc = [IO.File]::ReadAllText((Join-Path $script:ToolsDir 'DiscoveryLauncher.psm1'))
    Test-Case 'owner helper: CAP_CHOWN and uid 0 appear only in the owner helper' (@([regex]::Matches($launcherSrc, "'--cap-add'")).Count -eq 1 -and @([regex]::Matches($launcherSrc, "'0:0'")).Count -eq 1)

    # ---------------------------------------------------------------- probe diagnostic volumes
    $root = New-TestRepo
    $fake = Install-Fake $root
    $fake.State.OnStart = { param($name, $s) $c = $s.Containers[$name]; $vol = ($c.Mounts | Where-Object { $_.Destination -eq '/run/out' }).Source; [IO.File]::WriteAllText((Join-Path $s.Volumes[$vol] 'probe-result.json'), '{"ok":true}') }
    $pr = Start-Test -Root $root -Profile 'probe'
    $pp = Get-RunPaths -RepoRoot $root -RunId $pr.RunId
    $prRec = ConvertFrom-JsonStrict -Text ([IO.File]::ReadAllText((Join-Path $pp.Incoming "$($pr.RunId).launcher.json")))
    Test-Case 'probe volume: labelled volume-kind probe-diagnostic and start probe; a Run volume is labelled run' ($fake.State.VolumeLabels[$pp.Volume]['phoenix.discovery.volume-kind'] -ceq 'probe-diagnostic' -and $fake.State.VolumeLabels[$pp.Volume]['phoenix.discovery.start'] -ceq 'probe' -and (Get-VolumeKind -Profile 'run') -ceq 'run' -and $prRec['volumeKind'] -ceq 'probe-diagnostic' -and $prRec['volumeRemoval'] -ceq 'requires_human_approval')
    $reasonBefore = [IO.File]::ReadAllBytes((Join-Path $pp.Export 'REASON.json')); $resultBefore = [IO.File]::ReadAllBytes((Join-Path $pp.Export 'probe-result.json'))
    $fake.State.OnStart = $null
    $next = Start-Test -Root $root
    $nRec = ConvertFrom-JsonStrict -Text ([IO.File]::ReadAllText((Join-Path (Get-RunPaths -RepoRoot $root -RunId $next.RunId).Incoming "$($next.RunId).launcher.json")))
    Test-Case 'probe volume: the next start reports it as kept, does not mark it interrupted, and leaves its Reason_File and probe result byte-identical' ((@($nRec['probeDiagnosticVolumesKept']) -contains $pr.RunId) -and -not (@($nRec['interruptedRunsMarked']) -contains $pr.RunId) -and (Test-BytesEqual $reasonBefore ([IO.File]::ReadAllBytes((Join-Path $pp.Export 'REASON.json')))) -and (Test-BytesEqual $resultBefore ([IO.File]::ReadAllBytes((Join-Path $pp.Export 'probe-result.json')))))
    Test-Case 'probe volume: no tool removed it (no volume rm of the probe volume in any call)' ($fake.State.Volumes.ContainsKey($pp.Volume) -and @($fake.State.Calls | Where-Object { $_ -ceq "volume rm $($pp.Volume)" }).Count -eq 0)
    # a probe volume whose Launcher was killed before any export: only then is a Reason_File interrupted created
    $root = New-TestRepo
    $fake = Install-Fake $root
    $kId = 'run-20250101T000000Z-bbbbbbbbbbbb'
    $kDir = Join-Path $fake.State.VolumeRoot "phoenix-run-$kId"; [void][IO.Directory]::CreateDirectory($kDir)
    $fake.State.Volumes["phoenix-run-$kId"] = $kDir; $fake.State.VolumeLabels["phoenix-run-$kId"] = @{ 'phoenix.discovery.volume-kind' = 'probe-diagnostic' }
    [void](Start-Test -Root $root)
    $kReason = Join-Path $root "discovery/runs/.incoming/$kId/REASON.json"
    Test-Case 'probe volume: without any export directory it gets a Reason_File interrupted and stays (nothing to overwrite)' ((Test-Path -LiteralPath $kReason) -and (ConvertFrom-JsonStrict -Text ([IO.File]::ReadAllText($kReason)))['step'] -ceq 'interrupted' -and $fake.State.Volumes.ContainsKey("phoenix-run-$kId"))
    # the export guard: a probe export never removes its volume even if it were complete
    $root = New-TestRepo
    $fake = Install-Fake $root
    $gId = New-DiscoveryRunId; $gp = Get-RunPaths -RepoRoot $root -RunId $gId
    [void](Invoke-DockerCli -Arguments @('volume', 'create', $gp.Volume)); [void](New-TestSealedRun -Dir $fake.State.Volumes[$gp.Volume])
    $g = Invoke-RunExport -RepoRoot $root -RunId $gId -Profile 'probe'
    Test-Case 'probe volume: Invoke-RunExport with the probe profile never removes the volume (probe_diagnostic_kept)' ($g.Disposition -ceq 'probe_diagnostic_kept' -and $fake.State.Volumes.ContainsKey($gp.Volume) -and @($fake.State.Calls | Where-Object { $_ -like 'volume rm *' }).Count -eq 0)
    # ---------------------------------------------------------------- end of a start: own container removal (2026-11-14) and flat lists
    function Get-RecordOf { param($Root, $RunId) foreach ($pth in @((Join-Path $Root "discovery/runs/$RunId.launcher.json"), (Join-Path $Root "discovery/runs/.incoming/$RunId.launcher.json"))) { if (Test-Path -LiteralPath $pth) { return [pscustomobject]@{ Path = $pth; Text = [IO.File]::ReadAllText($pth); Rec = (ConvertFrom-JsonStrict -Text ([IO.File]::ReadAllText($pth))) } } }; $null }
    $sealed = { param($name, $s) $c = $s.Containers[$name]; $vol = ($c.Mounts | Where-Object { $_.Destination -eq '/run/out' }).Source; [void](New-TestSealedRun -Dir $s.Volumes[$vol]) }
    $root = New-TestRepo
    $fake = Install-Fake $root
    $fake.State.Containers['bystander'] = @{ Running = $false; ExitCode = '0'; Labels = @{ 'phoenix.discovery.role' = 'other' }; Mounts = @(); Networks = @(); Polls = $null }
    $fake.State.OnStart = $sealed
    $res = Start-Test -Root $root
    $own = Get-ContainerName -RunId $res.RunId
    $rec = Get-RecordOf $root $res.RunId
    $rms = @($fake.State.Calls | Where-Object { $_ -like 'rm *' })
    Test-Case 'end (complete Run): the own container is removed by its creation ID with a plain rm (no --force, no -v), after the export; the record says removed' ($res.Code -eq 'complete' -and $rms.Count -eq 1 -and $rms[0] -ceq "rm id-$own" -and -not $fake.State.Containers.ContainsKey($own) -and $rec.Rec['containerRemoval']['outcome'] -ceq 'removed' -and $rec.Rec['containerId'] -ceq "id-$own") ($rms -join ' | ')
    $calls = @($fake.State.Calls); $iCopy = [Array]::FindIndex([string[]]$calls, [Predicate[string]]{ param($c) $c -like '*export-helper*' }); $iRm = [Array]::FindIndex([string[]]$calls, [Predicate[string]]{ param($c) $c -like 'rm *' })
    Test-Case 'end: the order is stop confirmed, export copy, then the removal; other containers are untouched' ($iCopy -ge 0 -and $iRm -gt $iCopy -and $fake.State.Containers.ContainsKey('bystander'))
    Test-Case 'flat lists: with nothing to recover the record has leftoverContainersStopped [] and interruptedRunsMarked [] (never [[]])' ($rec.Text.Contains('"leftoverContainersStopped":[]') -and $rec.Text.Contains('"interruptedRunsMarked":[]') -and -not $rec.Text.Contains('[[')) 
    $again = Enter-RunLock -LockPath (Join-Path $root 'discovery/locks/discovery-run.lock')
    Test-Case 'end: the Run lock is released after the removal' ($null -ne $again); if ($again) { $again.Dispose() }

    $root = New-TestRepo
    $fake = Install-Fake $root
    $fake.State.OnStart = { param($name, $s) $c = $s.Containers[$name]; $vol = ($c.Mounts | Where-Object { $_.Destination -eq '/run/out' }).Source; [IO.File]::WriteAllText((Join-Path $s.Volumes[$vol] 'probe-result.json'), '{"ok":true}') }
    $pr = Start-Test -Root $root -Profile 'probe'
    $pp = Get-RunPaths -RepoRoot $root -RunId $pr.RunId
    $prRec = Get-RecordOf $root $pr.RunId
    Test-Case 'end (probe): the container is removed, the probe volume is kept, the evidence (probe-result.json, REASON.json) is kept' (-not $fake.State.Containers.ContainsKey((Get-ContainerName -RunId $pr.RunId)) -and $fake.State.Volumes.ContainsKey($pp.Volume) -and (Test-Path -LiteralPath (Join-Path $pp.Export 'probe-result.json')) -and (Test-Path -LiteralPath (Join-Path $pp.Export 'REASON.json')) -and $prRec.Rec['containerRemoval']['outcome'] -ceq 'removed' -and $prRec.Rec['volumeRemoval'] -ceq 'requires_human_approval' -and @($fake.State.Calls | Where-Object { $_ -like 'volume rm *' }).Count -eq 0)

    $root = New-TestRepo
    $fake = Install-Fake $root
    $fake.State.OnStart = $sealed; $fake.State.FailCopy = $true
    $r1 = Start-Test -Root $root; $rr = Get-RecordOf $root $r1.RunId
    Test-Case 'end: evidence not saved (copy failure): the container is kept and reported (evidence_not_saved); nothing is removed' ($fake.State.Containers.ContainsKey((Get-ContainerName -RunId $r1.RunId)) -and $rr.Rec['containerRemoval']['outcome'] -ceq 'kept' -and $rr.Rec['containerRemoval']['reason'] -ceq 'evidence_not_saved' -and @($fake.State.Calls | Where-Object { $_ -like 'rm *' }).Count -eq 0)

    $root = New-TestRepo
    $fake = Install-Fake $root
    $fake.State.OnStart = $sealed; $fake.State.IdOverride = 'id-someone-else'
    $r2 = Start-Test -Root $root; $rr = Get-RecordOf $root $r2.RunId
    Test-Case 'end: identity mismatch (the ID behind the name differs): the container is kept (identity_mismatch); no rm' ($fake.State.Containers.ContainsKey((Get-ContainerName -RunId $r2.RunId)) -and $rr.Rec['containerRemoval']['reason'] -ceq 'identity_mismatch' -and @($fake.State.Calls | Where-Object { $_ -like 'rm *' }).Count -eq 0)

    $root = New-TestRepo
    $fake = Install-Fake $root
    $fake.State.OnStart = $sealed; $fake.State.FailRm = $true
    $r3 = Start-Test -Root $root; $rr = Get-RecordOf $root $r3.RunId
    $lk = Enter-RunLock -LockPath (Join-Path $root 'discovery/locks/discovery-run.lock')
    Test-Case 'end: a failed rm keeps the container (rm_failed), the Run stays complete, and the locks are still released' ($r3.Code -eq 'complete' -and $rr.Rec['containerRemoval']['reason'] -ceq 'rm_failed' -and $null -ne $lk); if ($lk) { $lk.Dispose() }

    $root = New-TestRepo
    $fake = Install-Fake $root
    $fake.State.OnStart = { param($name, $s) $s.Containers[$name].Polls = $null }   # never ends by itself
    $fake.State.StopFails = $true
    $script:MaxRunHook = $null
    $r4 = Invoke-DiscoveryStart -RepoRoot $root -Profile 'run' -MutexName (New-TestMutexName) -LockPath (Join-Path $root 'discovery/locks/discovery-run.lock') -Log $quiet
    $lk = Enter-RunLock -LockPath (Join-Path $root 'discovery/locks/discovery-run.lock')
    Test-Case 'end: a container that is not confirmed stopped is kept (no rm), and the Run lock is not released by the Launcher' (@($fake.State.Calls | Where-Object { $_ -like 'rm *' }).Count -eq 0 -and $fake.State.Containers.ContainsKey((Get-ContainerName -RunId $r4.RunId)) -and $null -eq $lk); if ($lk) { $lk.Dispose() }

    $root = New-TestRepo
    $fake = Install-Fake $root
    $fake.State.Containers['phoenix-discovery-run-x'] = @{ Running = $false; ExitCode = '0'; Labels = @{ 'phoenix.discovery.role' = 'runtime'; 'phoenix.discovery.run-id' = 'run-x' }; Mounts = @(); Networks = @(); Polls = $null }
    $first = Remove-OwnRunContainer -ContainerId 'id-phoenix-discovery-run-x' -RunId 'run-x' -StopConfirmed $true -EvidenceSaved $true
    $second = Remove-OwnRunContainer -ContainerId 'id-phoenix-discovery-run-x' -RunId 'run-x' -StopConfirmed $true -EvidenceSaved $true
    Test-Case 'idempotent: a second removal of the same container is absent (already_removed) and sends no second rm' ($first.Outcome -eq 'removed' -and $second.Outcome -eq 'absent' -and @($fake.State.Calls | Where-Object { $_ -like 'rm *' }).Count -eq 1)
    $fake.State.Containers['phoenix-discovery-run-y'] = @{ Running = $false; ExitCode = '0'; Labels = @{ 'phoenix.discovery.role' = 'runtime'; 'phoenix.discovery.run-id' = 'run-y' }; Mounts = @(); Networks = @(); Polls = $null }
    $wrong = Remove-OwnRunContainer -ContainerId 'id-phoenix-discovery-run-y' -RunId 'run-x' -StopConfirmed $true -EvidenceSaved $true
    $fake.State.Containers['phoenix-discovery-run-z'] = @{ Running = $true; ExitCode = '0'; Labels = @{ 'phoenix.discovery.role' = 'runtime'; 'phoenix.discovery.run-id' = 'run-z' }; Mounts = @(); Networks = @(); Polls = $null }
    $running = Remove-OwnRunContainer -ContainerId 'id-phoenix-discovery-run-z' -RunId 'run-z' -StopConfirmed $true -EvidenceSaved $true
    Test-Case 'never another container: a container of another Run is kept (identity_mismatch); a running one is kept (still_running)' ($wrong.Reason -eq 'identity_mismatch' -and $running.Reason -eq 'still_running' -and $fake.State.Containers.ContainsKey('phoenix-discovery-run-y') -and $fake.State.Containers.ContainsKey('phoenix-discovery-run-z'))
    $fake.State.Containers['phoenix-discovery-run-w'] = @{ Running = $false; ExitCode = '0'; Labels = @{ 'phoenix.discovery.role' = 'runtime'; 'phoenix.discovery.run-id' = 'run-w' }; Mounts = @(); Networks = @(); Polls = $null }
    $nsc = Remove-OwnRunContainer -ContainerId 'id-phoenix-discovery-run-w' -RunId 'run-w' -StopConfirmed $false -EvidenceSaved $true
    $nev = Remove-OwnRunContainer -ContainerId 'id-phoenix-discovery-run-w' -RunId 'run-w' -StopConfirmed $true -EvidenceSaved $false
    Test-Case 'guards: without a confirmed stop, or without saved evidence, an exited container of this Run is kept (stop_not_confirmed, evidence_not_saved)' ($nsc.Reason -eq 'stop_not_confirmed' -and $nev.Reason -eq 'evidence_not_saved' -and $fake.State.Containers.ContainsKey('phoenix-discovery-run-w'))
    $srcL = [IO.File]::ReadAllText((Join-Path $script:ToolsDir 'DiscoveryLauncher.psm1'))
    Test-Case 'static: the Launcher never removes a container with --force or -v (rm only through Remove-OwnRunContainer)' (@([regex]::Matches($srcL, "@\('rm'")).Count -eq 1 -and -not ($srcL -match "'rm',\s*'(-f|--force|-v|--volumes)'"))

    $root = New-TestRepo
    $fake = Install-Fake $root
    $fake.State.Containers['leftover'] = @{ Running = $true; ExitCode = '0'; Labels = @{ 'phoenix.discovery.role' = 'runtime' }; Mounts = @(); Networks = @(); Polls = $null }
    $oldId = 'run-20250101T000000Z-cccccccccccc'
    $fake.State.Volumes["phoenix-run-$oldId"] = (New-TempDir)
    $fake.State.OnStart = $sealed
    $r5 = Start-Test -Root $root; $rr = Get-RecordOf $root $r5.RunId
    Test-Case 'flat lists: with one leftover and one interrupted Run the lists are one-dimensional ["leftover"] and [run id]' ($rr.Text.Contains('"leftoverContainersStopped":["leftover"]') -and $rr.Text.Contains("`"interruptedRunsMarked`":[`"$oldId`"]") -and -not $rr.Text.Contains('[[')) 
    $realRec = Join-Path $script:RepoRoot 'discovery/runs/.incoming/run-20261114T024339Z-5d10ba5ec199.launcher.json'
    if (Test-Path -LiteralPath $realRec) { Test-Case 'evidence: the 2.20 Launcher record is unchanged (SHA-256 dfde95b8...)' ((Get-Sha256HexOfFile -Path $realRec) -ceq 'dfde95b884e9ddbd819129f32ddcb647be3ad3f39a8df9a5ed4d71dd9e648344') }
    else { Write-Host 'NOT MEASURED: the local 2.20 Launcher record is absent on this machine' -ForegroundColor Yellow }
    # ---------------------------------------------------------------- export: negative cases and disposition (task 2.21)
    function New-ExportCase {
        param([scriptblock]$Damage)
        $root = New-TestRepo
        $fake = Install-Fake $root
        $id = New-DiscoveryRunId
        $p = Get-RunPaths -RepoRoot $root -RunId $id
        $vol = New-TempDir
        $fake.State.Volumes[$p.Volume] = $vol
        [void](New-TestSealedRun -Dir $vol)
        if ($Damage) { & $Damage $vol }
        [pscustomobject]@{ Root = $root; Fake = $fake; Id = $id; Paths = $p; Vol = $vol }
    }
    function Test-Incomplete {
        param($Case, $Result, [string]$Step)
        $dir = $Result.Location
        $reasonFile = Join-Path $dir 'REASON.json'
        $reasonStep = if (Test-Path -LiteralPath $reasonFile) { (ConvertFrom-JsonStrict -Text ([IO.File]::ReadAllText($reasonFile)))['step'] } else { $null }
        $noMarker = -not (Test-Path -LiteralPath (Join-Path $Case.Paths.Export 'COMPLETE') -PathType Leaf) -and -not (Test-Path -LiteralPath (Join-Path $Case.Paths.Final 'COMPLETE') -PathType Leaf)
        $noReader = -not ((Test-Path -LiteralPath $Case.Paths.Final) -and (Test-CompletedRun -Path $Case.Paths.Final)) -and -not ((Test-Path -LiteralPath $Case.Paths.Export) -and (Test-CompletedRun -Path $Case.Paths.Export))
        $Result.Outcome -eq 'incomplete' -and $Result.Step -eq $Step -and $reasonStep -ceq $Step -and $noMarker -and $noReader -and $Case.Fake.State.Volumes.ContainsKey($Case.Paths.Volume) -and $Result.Disposition -eq 'kept_for_diagnosis'
    }
    $c = New-ExportCase
    $r = Invoke-RunExport -RepoRoot $c.Root -RunId $c.Id
    Test-Case 'export: positive control: complete, accepted by the reader, volume removed' ($r.Outcome -eq 'complete' -and (Test-CompletedRun -Path $c.Paths.Final) -and $r.Disposition -eq 'removed_after_verified_export')
    $neg = @(
        @{ Name = 'one modified file'; Damage = { param($v) [IO.File]::WriteAllText((Join-Path $v 'records.jsonl'), ([IO.File]::ReadAllText((Join-Path $v 'records.jsonl'))).Replace('"n":1', '"n":7')) }; Step = 'verify' },
        @{ Name = 'one unlisted file'; Damage = { param($v) [IO.File]::WriteAllText((Join-Path $v 'extra.txt'), 'x') }; Step = 'verify' },
        @{ Name = 'one missing listed file'; Damage = { param($v) Remove-Item -LiteralPath (Get-ChildItem -LiteralPath (Join-Path $v 'blobs') | Select-Object -First 1).FullName }; Step = 'verify' },
        @{ Name = 'a record whose content changed while its links stayed intact (payload and artifact hash rewritten)'; Damage = { param($v)
                $rp = Join-Path $v 'records.jsonl'; $txt = [IO.File]::ReadAllText($rp); $new = $txt.Replace('"n":2', '"n":7'); if ($new -ceq $txt) { throw 'the damage did not apply' }; [IO.File]::WriteAllText($rp, $new)
                $mp = Join-Path $v 'manifest.json'; $m = ConvertFrom-JsonStrict -Text ([IO.File]::ReadAllText($mp)); foreach ($a in $m['artifacts']) { if ($a['path'] -ceq 'records.jsonl') { $a['sha256'] = Get-Sha256HexOfFile -Path $rp } }; [IO.File]::WriteAllText($mp, (ConvertTo-CanonicalJson -Value $m)) }; Step = 'verify' },
        @{ Name = 'a broken chain link (record and its artifact hash rewritten)'; Damage = { param($v)
                $rp = Join-Path $v 'records.jsonl'; $lines = [IO.File]::ReadAllText($rp).Split("`n"); $lines[1] = $lines[1] -replace '"prevHash":"[0-9a-f]{64}"', ('"prevHash":"' + ('f' * 64) + '"'); [IO.File]::WriteAllText($rp, ($lines -join "`n"))
                $mp = Join-Path $v 'manifest.json'; $m = ConvertFrom-JsonStrict -Text ([IO.File]::ReadAllText($mp)); foreach ($a in $m['artifacts']) { if ($a['path'] -ceq 'records.jsonl') { $a['sha256'] = Get-Sha256HexOfFile -Path $rp } }; [IO.File]::WriteAllText($mp, (ConvertTo-CanonicalJson -Value $m)) }; Step = 'verify' },
        @{ Name = 'no Run_Manifest'; Damage = { param($v) Remove-Item -LiteralPath (Join-Path $v 'manifest.json') }; Step = 'verify' },
        @{ Name = 'a Completion_Marker that cannot be written'; Damage = { param($v) [void][IO.Directory]::CreateDirectory((Join-Path $v 'COMPLETE')) }; Step = 'marker' }
    )
    foreach ($n in $neg) {
        $c = New-ExportCase -Damage $n.Damage
        $r = Invoke-RunExport -RepoRoot $c.Root -RunId $c.Id
        Test-Case "export: $($n.Name) gives no COMPLETE, a Reason_File '$($n.Step)', the volume kept, and no reader accepts the Run" (Test-Incomplete $c $r $n.Step) "outcome=$($r.Outcome) step=$($r.Step)"
    }
    $c = New-ExportCase
    $c.Fake.State.FailCopy = $true
    $r = Invoke-RunExport -RepoRoot $c.Root -RunId $c.Id
    Test-Case 'export: a copy failure (helper made to fail) gives the step copy' (Test-Incomplete $c $r 'copy')
    $c = New-ExportCase
    $r = Invoke-RunExport -RepoRoot $c.Root -RunId $c.Id
    [IO.File]::WriteAllText((Join-Path $c.Paths.Final 'COMPLETE'), ('0' * 64))
    Test-Case 'reader: a marker hash that differs from the Run_Manifest hash is not accepted' (-not (Test-CompletedRun -Path $c.Paths.Final))
    $c = New-ExportCase
    $c.Fake.State.FailVolumeRm = $true
    $r = Invoke-RunExport -RepoRoot $c.Root -RunId $c.Id
    Test-Case 'disposition: a failed volume removal keeps the Run complete and says kept_for_diagnosis' ($r.Outcome -eq 'complete' -and $r.Disposition -eq 'kept_for_diagnosis' -and (Test-CompletedRun -Path $c.Paths.Final))

    # the Launcher killed before the marker: the export holds the copy, no marker; the next start marks it interrupted
    $c = New-ExportCase
    [void][IO.Directory]::CreateDirectory($c.Paths.Export)
    foreach ($item in Get-ChildItem -LiteralPath $c.Vol -Force) { Copy-Item -LiteralPath $item.FullName -Destination $c.Paths.Export -Recurse }
    $marked = Set-InterruptedRuns -RepoRoot $c.Root
    $rf = Join-Path $c.Paths.Export 'REASON.json'
    Test-Case 'killed before the marker: no reader accepts the export, the next start writes interrupted, and the volume is kept' (-not (Test-CompletedRun -Path $c.Paths.Export) -and ($marked -contains $c.Id) -and (ConvertFrom-JsonStrict -Text ([IO.File]::ReadAllText($rf)))['step'] -ceq 'interrupted' -and $c.Fake.State.Volumes.ContainsKey($c.Paths.Volume))

    # ---------------------------------------------------------------- heartbeat schedule (fake clock)
    $root = New-TestRepo
    $fake = Install-Fake $root
    $fake.State.Containers['hb'] = @{ Running = $true; ExitCode = '0'; Labels = @{}; Mounts = @(); Networks = @(); Polls = 6 }
    $leaseDir = Join-Path $root 'discovery/leases/hb'
    [void][IO.Directory]::CreateDirectory((Split-Path $leaseDir))
    $lease = New-RunLease -LeaseDir $leaseDir -RunId 'hb' -Nonce 'n' -Settings (Get-LeaseSettings)
    $script:fakeNow = 0L
    $script:sleeps = [System.Collections.Generic.List[long]]::new()
    Set-LauncherTimeHooks -NowMs { $script:fakeNow } -SleepMs { param($ms) $script:sleeps.Add($ms); $script:fakeNow += $ms; if ($script:sleeps.Count -eq 3) { $script:fakeNow += 900 } }
    $w = Wait-RuntimeContainer -Container 'hb' -Lease $lease -Settings (Get-LeaseSettings)
    Test-Case 'heartbeat: the counter starts at 1 and increases by 1 per beat; beats are scheduled from the previous one; a delay above H + J is counted' ($w.Beats -eq 6 -and [IO.File]::ReadAllText((Join-Path $leaseDir 'heartbeat')) -eq '7' -and $w.LateBeats -eq 1 -and $script:sleeps[0] -eq 1000 -and $script:sleeps[3] -eq 100) "beats=$($w.Beats) late=$($w.LateBeats) sleeps=$($script:sleeps -join ',')"

    # ---------------------------------------------------------------- the verification against the TypeScript vector
    $vector = Join-Path $script:RepoRoot 'packages/discovery-loop/test-vectors/sealed-run'
    if (Test-Path -LiteralPath (Join-Path $vector 'manifest.json')) {
        $copy = Join-Path (New-TempDir) 'run'
        Copy-Item -LiteralPath $vector -Destination $copy -Recurse
        $v = Test-RunDirectory -Path $copy
        [IO.File]::WriteAllText((Join-Path $copy 'COMPLETE'), $v.ManifestSha256)
        Test-Case 'cross-check: the PowerShell verification accepts the Run written by the TypeScript store (golden vector)' ($v.Result -eq 'success' -and (Test-CompletedRun -Path $copy)) (($v.Mismatches | ForEach-Object { "$($_.Where):$($_.Kind)" }) -join ',')
    } else {
        Write-Host 'UNVERIFIED: packages/discovery-loop/test-vectors/sealed-run is missing (generate it in the toolchain container); the cross-check did not run' -ForegroundColor Yellow
        $script:FailCount++
    }
}