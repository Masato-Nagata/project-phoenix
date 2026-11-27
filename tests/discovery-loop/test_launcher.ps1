#Requires -Version 7.0
# Launcher tests (tasks 2.18, 2.21, 2.22, 2.23) with the fake container CLI, temporary directories, and TEST-SPECIFIC mutex names.
# No real daemon, no real conformance mutex, no Legacy_App, no network. A temporary repository root replaces the real one, so nothing
# under the real discovery/ is read or written.
. (Join-Path $PSScriptRoot 'lib/testlib.ps1')
. (Join-Path $PSScriptRoot 'lib/fakeDocker.ps1')
Import-Module (Join-Path $script:ToolsDir 'DiscoveryCommon.psm1') -Force -DisableNameChecking
Import-Module (Join-Path $script:ToolsDir 'LeaseTiming.psm1') -Force -DisableNameChecking
Import-Module (Join-Path $script:ToolsDir 'ApprovalStore.psm1') -Force -DisableNameChecking
Import-Module (Join-Path $script:ToolsDir 'InputFileGuard.psm1') -Force -DisableNameChecking
Import-Module (Join-Path $script:ToolsDir 'RuntimeReport.psm1') -Force -DisableNameChecking
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
    $inputTable = Get-InputFileTable
    foreach ($row in $inputTable) { $fp = Join-Path $root ($row.RelPath -replace '/', '\'); [void][IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($fp)); [IO.File]::WriteAllText($fp, "synthetic test input for $($row.Label)`n", $utf8) }
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
    $extra = @{}; if ($Profile -eq 'run') { $extra['AuditConfig'] = 'fixture' }
    Invoke-DiscoveryStart -RepoRoot $Root -Profile $Profile -MutexName $MutexName -LockPath (Join-Path $Root 'discovery/locks/discovery-run.lock') -Log $quiet @extra
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

# ---------------------------------------------------------------- task 4.9-C2 helpers (script scope, so that fake hooks can call them)
function Get-InputPath { param([string]$Root, [string]$Label) $tb = Get-InputFileTable; $row = @($tb | Where-Object { $_.Label -ceq $Label })[0]; Join-Path $Root ($row.RelPath -replace '/', '\') }
# every input file can be opened for writing again (no handle of the Launcher holds it)
function Test-InputsReleased {
    param([string]$Root)
    $tb = Get-InputFileTable
    foreach ($row in $tb) {
        $fp = Join-Path $Root ($row.RelPath -replace '/', '\')
        if (Test-Path -LiteralPath $fp -PathType Leaf) { try { $s = [IO.File]::Open($fp, 'Open', 'Write', 'ReadWrite'); $s.Dispose() } catch { return $false } }
    }
    $true
}
# a writer is refused on every input file (the Launcher holds them)
function Test-InputsHeld {
    param([string]$Root)
    $tb = Get-InputFileTable
    foreach ($row in $tb) { $fp = Join-Path $Root ($row.RelPath -replace '/', '\'); try { $s = [IO.File]::Open($fp, 'Open', 'Write', 'ReadWrite'); $s.Dispose(); return $false } catch { } }
    $true
}
function Start-C2 {
    param([string]$Root, [string]$Profile = 'run', [string]$Audit, [switch]$NoAudit, [scriptblock]$Log = { param($m) })
    $x = @{}; if (-not $NoAudit) { $x['AuditConfig'] = $Audit }
    Invoke-DiscoveryStart -RepoRoot $Root -Profile $Profile -MutexName (New-TestMutexName) -LockPath (Join-Path $Root 'discovery/locks/discovery-run.lock') -Log $Log @x
}
function Get-LeaseDirOf { param($Container) @($Container.Mounts | Where-Object { $_.Destination -eq '/run/lease' })[0].Source }
function Get-C2Record { param([string]$Root, [string]$RunId) foreach ($pth in @((Join-Path $Root "discovery/runs/$RunId.launcher.json"), (Join-Path $Root "discovery/runs/.incoming/$RunId.launcher.json"))) { if (Test-Path -LiteralPath $pth) { return [pscustomobject]@{ Text = [IO.File]::ReadAllText($pth); Rec = (ConvertFrom-JsonStrict -Text ([IO.File]::ReadAllText($pth))) } } }; $null }
function Get-ReasonText { param([string]$Root, [string]$RunId) $pp = Get-RunPaths -RepoRoot $Root -RunId $RunId; foreach ($d in @($pp.Export, $pp.Final)) { $f = Join-Path $d 'REASON.json'; if (Test-Path -LiteralPath $f) { return [IO.File]::ReadAllText($f) } }; $null }
function Get-CallIndex { param($Fake, [string]$Pattern) [Array]::FindIndex([string[]]@($Fake.State.Calls), [Predicate[string]]{ param($c) $c -like $Pattern }) }
# A child process for the bounded capture (not Docker): writes N bytes to each stream, optionally interleaved or invalid UTF-8, sleeps, exits.
$script:EmitScript = @"
param([int]`$Out = 0, [int]`$Err = 0, [int]`$Sleep = 0, [int]`$Exit = 0, [switch]`$Invalid, [int]`$Interleave = 0)
`$o = [Console]::OpenStandardOutput(); `$e = [Console]::OpenStandardError()
function W(`$s, [long]`$n, [byte]`$v) { if (`$n -le 0) { return }; `$buf = [byte[]]::new([Math]::Min(65536, `$n)); [Array]::Fill(`$buf, `$v); `$left = `$n; while (`$left -gt 0) { `$k = [int][Math]::Min(`$left, `$buf.Length); `$s.Write(`$buf, 0, `$k); `$left -= `$k }; `$s.Flush() }
if (`$Invalid) { `$b = [byte[]](0x7B, 0xFF, 0xC0, 0xAF, 0xED, 0xA0, 0x80, 0x7D, 0x0A); `$e.Write(`$b, 0, `$b.Length); `$e.Flush() }
elseif (`$Interleave -gt 0) { `$wo = 0; `$we = 0; while (`$wo -lt `$Out -or `$we -lt `$Err) { if (`$wo -lt `$Out) { `$k = [Math]::Min(`$Interleave, `$Out - `$wo); W `$o `$k 0x6F; `$wo += `$k }; if (`$we -lt `$Err) { `$k = [Math]::Min(`$Interleave, `$Err - `$we); W `$e `$k 0x65; `$we += `$k } } }
else { W `$o `$Out 0x6F; W `$e `$Err 0x65 }
if (`$Sleep -gt 0) { Start-Sleep -Milliseconds `$Sleep }
exit `$Exit
"@
function Invoke-Emit {
    param([string]$Script, [string[]]$EmitArgs, [int]$Limit = 8192, [int]$TimeoutMs = 20000)
    $sw = [Diagnostics.Stopwatch]::StartNew()
    $r = Invoke-BoundedProcess -FileName ((Get-Process -Id $PID).Path) -Arguments (@('-NoProfile', '-NonInteractive', '-File', $Script) + $EmitArgs) -LimitBytes $Limit -TimeoutMs $TimeoutMs
    $sw.Stop()
    $gone = $true; if ($r.ProcessId -gt 0) { $gone = $null -eq (Get-Process -Id $r.ProcessId -ErrorAction SilentlyContinue) }
    [pscustomobject]@{ R = $r; Ms = [long]$sw.ElapsedMilliseconds; Gone = $gone }
}
function Test-AllBytes { param([byte[]]$B, [byte]$V) @($B | Where-Object { $_ -ne $V }).Count -eq 0 }
# The pwsh child process of the retention tests (task 4.9-C2 follow-up). It writes key=value lines only.
$script:RetentionChild = @'
param([string]$Root, [string]$ControlRoot, [string]$Tools, [string]$Lib, [string]$MutexName, [string]$Mode)
$ErrorActionPreference = 'Stop'
. (Join-Path $Lib 'fakeDocker.ps1')
foreach ($m in 'DiscoveryCommon', 'LeaseTiming', 'ApprovalStore', 'InputFileGuard', 'RuntimeReport', 'DiscoveryLauncher') { Import-Module (Join-Path $Tools "$m.psm1") -Force -DisableNameChecking }
Add-Type -TypeDefinition 'public static class PhxMutexProbe { public static string Try(string n) { string r = "none"; var t = new System.Threading.Thread(() => { try { using (var m = new System.Threading.Mutex(false, n)) { bool got = m.WaitOne(0); r = got ? "acquired" : "held"; if (got) m.ReleaseMutex(); } } catch (System.Threading.AbandonedMutexException) { r = "abandoned"; } }); t.Start(); t.Join(); return r; } }'
$fake = New-FakeDocker -Root $Root
Set-DockerCliInvoker -Invoker $fake.Invoker
$script:now = 0L
Set-LauncherTimeHooks -NowMs { $script:now } -SleepMs { param($ms) $script:now += $ms }
$lockPath = Join-Path $Root 'discovery/locks/discovery-run.lock'
function Collect { [GC]::Collect(); [GC]::WaitForPendingFinalizers(); [GC]::Collect(); [GC]::WaitForPendingFinalizers() }
function Test-FilesHeld { param([string]$R) $tb = Get-InputFileTable; foreach ($row in $tb) { $fp = Join-Path $R ($row.RelPath -replace '/', '\'); try { $s = [IO.File]::Open($fp, 'Open', 'Write', 'ReadWrite'); $s.Dispose(); return $false } catch { } }; $true }
# Every input file is free: it exists AND a writer can open it. The labels in -Absent are files that the test deleted on purpose: they must NOT
# exist. Any other missing file, or any error, is not free.
function Test-FilesFree {
    param([string]$R, [string[]]$Absent = @())
    $tb = Get-InputFileTable
    foreach ($row in $tb) {
        $fp = Join-Path $R ($row.RelPath -replace '/', '\')
        if ($Absent -ccontains $row.Label) { if ([IO.File]::Exists($fp) -or [IO.Directory]::Exists($fp)) { return $false }; continue }
        if (-not [IO.File]::Exists($fp)) { return $false }
        try { $s = [IO.File]::Open($fp, 'Open', 'Write', 'ReadWrite'); $s.Dispose() } catch { return $false }
    }
    $true
}
# 'True' only for a sharing violation (another handle holds the Run lock); 'False' when the lock directory does not exist (no start reached the
# locks) or the open succeeds; any other error is 'error' (so that it matches neither expectation).
function Test-LockHeld {
    if (-not [IO.Directory]::Exists([IO.Path]::GetDirectoryName($lockPath))) { return $false }
    try { $s = [IO.FileStream]::new($lockPath, 'OpenOrCreate', 'ReadWrite', 'None'); $s.Dispose(); return $false }
    catch {
        $e = $_.Exception; while ($e -is [System.Management.Automation.MethodInvocationException] -and $null -ne $e.InnerException) { $e = $e.InnerException }
        if ($e -is [System.IO.IOException] -and ($e.HResult -band 0xFFFF) -eq 32) { return $true }
        return 'error'
    }
}
function Start-One { param([hashtable]$X) $r = Invoke-DiscoveryStart -RepoRoot $Root -Profile 'run' -MutexName $MutexName -LockPath $lockPath -Log { param($m) } @X; "$($r.Code)|$($r.ExitCode)|$($r.RunId)" }
function Out-Kv { param([string]$K, $V) [Console]::Out.WriteLine("$K=$V") }
switch ($Mode) {
    'unstopped' {
        $fake.State.OnStart = { param($name, $s) $s.Containers[$name].Polls = $null }
        $fake.State.StopFails = $true
        $first = (Start-One @{ AuditConfig = 'fixture' }).Split('|')
        $id = $first[2]
        Collect
        Out-Kv 'first_code' $first[0]; Out-Kv 'first_exit' $first[1]
        Out-Kv 'retained' (Test-UnstoppedRunRetained -RunId $id); Out-Kv 'count' (Get-UnstoppedRunRetainedCount)
        Out-Kv 'files_held_after_gc' (Test-FilesHeld $Root); Out-Kv 'lock_held_after_gc' (Test-LockHeld); Out-Kv 'mutex_after_gc' ([PhxMutexProbe]::Try($MutexName))
        $second = (Start-One @{ AuditConfig = 'fixture' }).Split('|')
        Collect
        Out-Kv 'second_code' $second[0]; Out-Kv 'second_exit' $second[1]; Out-Kv 'second_run_id_empty' ([string]::IsNullOrEmpty($second[2]))
        Out-Kv 'retained_after_second' (Test-UnstoppedRunRetained -RunId $id); Out-Kv 'count_after_second' (Get-UnstoppedRunRetainedCount)
        Out-Kv 'files_held_after_second' (Test-FilesHeld $Root); Out-Kv 'lock_held_after_second' (Test-LockHeld); Out-Kv 'mutex_after_second' ([PhxMutexProbe]::Try($MutexName))
        Import-Module (Join-Path $Tools 'DiscoveryLauncher.psm1') -Force -DisableNameChecking
        Remove-Module DiscoveryLauncher -Force
        Import-Module (Join-Path $Tools 'InputFileGuard.psm1') -Force -DisableNameChecking
        Collect
        Out-Kv 'retained_after_reload' ([Phoenix.Launcher.UnstoppedRunRetention]::Contains($id)); Out-Kv 'count_after_reload' ([Phoenix.Launcher.UnstoppedRunRetention]::Count)
        Out-Kv 'files_held_after_reload' (Test-FilesHeld $Root); Out-Kv 'lock_held_after_reload' (Test-LockHeld); Out-Kv 'mutex_after_reload' ([PhxMutexProbe]::Try($MutexName))
        # control: a guard that nothing references is closed by the garbage collector (so the retention above is not vacuous)
        function Open-Control { $g = Open-InputFileGuard -RepoRoot $ControlRoot -Table (Get-InputFileTable); [bool]$g.Ok }
        $opened = Open-Control
        Out-Kv 'control_opened' $opened
        Collect
        Out-Kv 'control_released_by_gc' (Test-FilesFree $ControlRoot)
    }
    'normal' {
        $fake.State.OnStart = { param($name, $s) $c = $s.Containers[$name]; $vol = ($c.Mounts | Where-Object { $_.Destination -eq '/run/out' }).Source; [void](New-TestSealedRun -Dir $s.Volumes[$vol]) }
        $r = (Start-One @{ AuditConfig = 'fixture' }).Split('|')
        Collect
        Out-Kv 'code' $r[0]; Out-Kv 'exit' $r[1]; Out-Kv 'retained' (Test-UnstoppedRunRetained -RunId $r[2]); Out-Kv 'count' (Get-UnstoppedRunRetainedCount)
        Out-Kv 'files_free' (Test-FilesFree $Root); Out-Kv 'lock_held' (Test-LockHeld); Out-Kv 'mutex' ([PhxMutexProbe]::Try($MutexName))
    }
    'refused' {
        $a = (Start-One @{}).Split('|')
        [IO.File]::Delete((Join-Path $Root 'discovery\config\run-config.json'))
        $b = (Start-One @{ AuditConfig = 'fixture' }).Split('|')
        Collect
        Out-Kv 'code_a' $a[0]; Out-Kv 'code_b' $b[0]; Out-Kv 'count' (Get-UnstoppedRunRetainedCount)
        Out-Kv 'files_free' (Test-FilesFree $Root -Absent @('run-config')); Out-Kv 'lock_held' (Test-LockHeld); Out-Kv 'mutex' ([PhxMutexProbe]::Try($MutexName))
    }
}
'@
# The pwsh child process of the G2-B2 kill tests (states A, B, C): the Launcher process ends at once at a chosen point.
$script:KillChild = @'
param([string]$Root, [string]$Tools, [string]$Lib, [string]$MutexName, [string]$KillAt)
$ErrorActionPreference = 'Stop'
. (Join-Path $Lib 'fakeDocker.ps1')
foreach ($m in 'DiscoveryCommon', 'LeaseTiming', 'ApprovalStore', 'InputFileGuard', 'RuntimeReport', 'DiscoveryLauncher') { Import-Module (Join-Path $Tools "$m.psm1") -Force -DisableNameChecking }
$fake = New-FakeDocker -Root $Root
Set-DockerCliInvoker -Invoker $fake.Invoker
$script:now = 0L
Set-LauncherTimeHooks -NowMs { $script:now } -SleepMs { param($ms) $script:now += $ms }
$fake.State.OnStart = { param($name, $s) $c = $s.Containers[$name]; $vol = ($c.Mounts | Where-Object { $_.Destination -eq '/run/out' }).Source; [void](New-TestSealedRun -Dir $s.Volumes[$vol]) }
# The Launcher process ends at once (no finally block runs), as a kill would end it. The state of the fake Docker is printed first.
$script:die = { param($s) $cn = @($s.Containers.Keys | Where-Object { $_ -like 'phoenix-discovery-*' }).Count; $vn = @($s.Volumes.Keys | Where-Object { $_ -like 'phoenix-run-*' }).Count; [Console]::Out.WriteLine("container_exists=$($cn -gt 0)"); [Console]::Out.WriteLine("volume_exists=$($vn -gt 0)"); [Console]::Out.Flush(); [Environment]::Exit(42) }
switch ($KillAt) {
    'before_container_removal' { $fake.State.OnCall = { param($call, $s) if ($call -like 'rm id-*') { & $script:die $s } } }
    'before_volume_removal' { $fake.State.OnCall = { param($call, $s) if ($call -like 'volume inspect --format*') { & $script:die $s } } }
    'after_volume_removal' { $fake.State.OnVolumeRm = { param($name, $s) & $script:die $s } }
}
$r = Invoke-DiscoveryStart -RepoRoot $Root -Profile 'run' -MutexName $MutexName -LockPath (Join-Path $Root 'discovery/locks/discovery-run.lock') -Log { param($m) } -AuditConfig 'fixture'
[Console]::Out.WriteLine('not_killed')
'@
Invoke-TestMain {
    Write-Host '=== Launcher (tasks 2.18, 2.21, 2.22, 2.23) ===' -ForegroundColor Cyan

    # ---------------------------------------------------------------- static checks of the entry point and the tools
    $tokens = $null; $errors = $null
    $ast = [System.Management.Automation.Language.Parser]::ParseFile($entry, [ref]$tokens, [ref]$errors)
    $params = @($ast.ParamBlock.Parameters | ForEach-Object { $_.Name.VariablePath.UserPath })
    $entryText = Get-Content -Raw -LiteralPath $entry
    Test-Case 'static: the entry point declares only -Probe and -AuditConfig (no parameter for the mutex name or the lock path)' (($params -join ',') -ceq 'Probe,AuditConfig' -and $errors.Count -eq 0) ($params -join ',')
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
    $pg = Open-InputFileGuard -RepoRoot $root -Table (Get-InputFileTable)
    $runArgs = if ($pg.Ok) { New-ContainerCreateArgs -Profile 'run' -RepoRoot $root -RunId 'run-x' -Nonce 'n' -PropagationDelayMs 1 -ImageId ('sha256:' + ('2' * 64)) -InputGuard $pg.Guard } else { @('phoenix/discovery-toolchain:m0') }
    if ($pg.Ok) { Close-InputFileGuard -Guard $pg.Guard }
    Test-Case 'probe: the probe is refused as a Run: the Run profile never uses the toolchain image' (-not ($runArgs -contains 'phoenix/discovery-toolchain:m0'))

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
    $r4 = Invoke-DiscoveryStart -RepoRoot $root -Profile 'run' -MutexName (New-TestMutexName) -LockPath (Join-Path $root 'discovery/locks/discovery-run.lock') -Log $quiet -AuditConfig 'fixture'
    $lk = Enter-RunLock -LockPath (Join-Path $root 'discovery/locks/discovery-run.lock')
    Test-Case 'end: a container that is not confirmed stopped is kept (no rm), and the Run lock is not released by the Launcher' (@($fake.State.Calls | Where-Object { $_ -like 'rm *' }).Count -eq 0 -and $fake.State.Containers.ContainsKey((Get-ContainerName -RunId $r4.RunId)) -and $null -eq $lk); if ($lk) { $lk.Dispose() }
    $r4Rec = Get-C2Record $root $r4.RunId
    Test-Case 'C2 end: while the stop is not confirmed the input file handles stay held in this process (no writer can open a file), the record says kept_stop_not_confirmed, no runtime report is taken, and the result is not complete' ((Test-InputsHeld $root) -and $null -ne $r4Rec -and $r4Rec.Rec['inputFileHandles'] -ceq 'kept_stop_not_confirmed' -and -not $r4Rec.Rec.Contains('runtimeReport') -and $r4.Code -cne 'complete' -and $r4.ExitCode -ne 0 -and @($fake.State.Calls | Where-Object { $_ -like 'logs *' }).Count -eq 0) "code=$($r4.Code)"
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
    # (G2-B1, 2026-11-26) before: the export removed the volume ($r.Disposition -eq 'removed_after_verified_export'). Now the export removes no volume (Remove-RunVolume does, after the container); the Run is still complete and accepted.
    Test-Case 'export: positive control: complete, accepted by the reader, and the export itself removes no volume (provisional kept_for_diagnosis)' ($r.Outcome -eq 'complete' -and (Test-CompletedRun -Path $c.Paths.Final) -and $r.Disposition -eq 'kept_for_diagnosis' -and $c.Fake.State.Volumes.ContainsKey($c.Paths.Volume) -and @($c.Fake.State.Calls | Where-Object { $_ -like 'volume rm*' }).Count -eq 0)
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
    # (G2-C, 2026-11-27) before: 'disposition: a failed volume removal keeps the Run complete and says kept_for_diagnosis' with the expectation
    # ($r.Outcome -eq 'complete' -and $r.Disposition -eq 'kept_for_diagnosis' -and (Test-CompletedRun -Path $c.Paths.Final)). Since G2-B1 the export
    # makes no volume removal, so that test no longer tested a removal. It now tests the duty of the export under the failure setting, with a
    # control that the setting is live: the export is complete and accepted, makes no `volume rm` call, keeps the volume, and its result and the
    # final artifact equal those of an export without the setting (unlike the positive control above, the removal is set to fail). The real failed
    # removal is tested through the Launcher ('G2 volume removal fails: ... rm_failed').
    $c = New-ExportCase
    $c.Fake.State.FailVolumeRm = $true
    $rmBefore = @($c.Fake.State.Calls | Where-Object { $_ -like 'volume rm*' }).Count
    $r = Invoke-RunExport -RepoRoot $c.Root -RunId $c.Id
    $rmAfterExport = @($c.Fake.State.Calls | Where-Object { $_ -like 'volume rm*' }).Count   # counted before the direct call below
    $live = Invoke-DockerCli -Arguments @('volume', 'rm', 'phoenix-run-control-absent')   # still the fake of $c (the next case installs its own)
    $plain = New-ExportCase
    $rp = Invoke-RunExport -RepoRoot $plain.Root -RunId $plain.Id
    $sameArtifact = (Get-Sha256HexOfFile -Path (Join-Path $c.Paths.Final 'manifest.json')) -ceq (Get-Sha256HexOfFile -Path (Join-Path $plain.Paths.Final 'manifest.json'))
    Test-Case 'export under a failing volume removal: complete, accepted, no volume rm call, the volume kept, and the same result as without the setting (the setting is live: a direct volume rm fails)' ($r.Outcome -eq 'complete' -and $r.Step -eq $null -and $r.Disposition -eq 'kept_for_diagnosis' -and (Test-CompletedRun -Path $c.Paths.Final) -and ($rmAfterExport - $rmBefore) -eq 0 -and $c.Fake.State.Volumes.ContainsKey($c.Paths.Volume) -and $rp.Outcome -eq $r.Outcome -and $rp.Disposition -eq $r.Disposition -and $sameArtifact -and $live.ExitCode -ne 0) "rmBefore=$rmBefore rmAfterExport=$rmAfterExport live=$($live.ExitCode)"

    # the Launcher killed before the marker: the export holds the copy, no marker; the next start marks it interrupted
    $c = New-ExportCase
    [void][IO.Directory]::CreateDirectory($c.Paths.Export)
    foreach ($item in Get-ChildItem -LiteralPath $c.Vol -Force) { Copy-Item -LiteralPath $item.FullName -Destination $c.Paths.Export -Recurse }
    $marked = Set-InterruptedRuns -RepoRoot $c.Root
    $rf = Join-Path $c.Paths.Export 'REASON.json'
    Test-Case 'killed before the marker: no reader accepts the export, the next start writes interrupted, and the volume is kept' (-not (Test-CompletedRun -Path $c.Paths.Export) -and ($marked -contains $c.Id) -and (ConvertFrom-JsonStrict -Text ([IO.File]::ReadAllText($rf)))['step'] -ceq 'interrupted' -and $c.Fake.State.Volumes.ContainsKey($c.Paths.Volume))

    # ================================================================ G2-B2 (2026-11-26): the Run_Volume is removed behind the container removal (fake Docker only)
    # The fake Docker refuses `volume rm` while any container, a stopped one included, references the volume.
    function Test-RunLockHeld { param([string]$Root) $ls = Enter-RunLock -LockPath (Join-Path $Root 'discovery/locks/discovery-run.lock'); if ($null -eq $ls) { return $true }; $ls.Dispose(); $false }
    function Get-G2Calls { param($Fake, [string]$Pattern) , @($Fake.State.Calls | Where-Object { $_ -like $Pattern }) }
    function Invoke-G2Run {
        param([scriptblock]$Setup, [bool]$Seal = $true, [string]$Profile = 'run')
        $root = New-TestRepo; $fake = Install-Fake $root; $script:g2Root = $root
        if ($Seal) { $fake.State.OnStart = { param($name, $s) $c = $s.Containers[$name]; $vol = ($c.Mounts | Where-Object { $_.Destination -eq '/run/out' }).Source; [void](New-TestSealedRun -Dir $s.Volumes[$vol]) } }
        if ($Setup) { & $Setup $fake }
        $res = if ($Profile -eq 'run') { Start-C2 -Root $root -Audit 'fixture' } else { Start-Test -Root $root -Profile $Profile }
        $pp = Get-RunPaths -RepoRoot $root -RunId $res.RunId
        [pscustomobject]@{ Root = $root; Fake = $fake; Res = $res; P = $pp; Rr = (Get-C2Record $root $res.RunId) }
    }
    # the volume is kept with this reason, no volume was removed, and the record says so (RmCalls: the number of `volume rm` calls that were made)
    function Test-G2Kept {
        param($G, [string]$Reason, [int]$RmCalls = 0)
        if ($null -eq $G.Rr) { return $false }
        $rec = $G.Rr.Rec
        $rec['volumeDisposition'] -ceq 'kept_for_diagnosis' -and $rec['volumeCleanup']['outcome'] -ceq 'kept' -and $rec['volumeCleanup']['reason'] -ceq $Reason -and
            $G.Fake.State.Volumes.ContainsKey($G.P.Volume) -and (Get-G2Calls $G.Fake 'volume rm*').Count -eq $RmCalls -and $G.Rr.Text.Contains('"volumeCleanup":{"outcome":"kept","reason":"' + $Reason + '"}')
    }
    $utf8b = [System.Text.UTF8Encoding]::new($false)

    # ---- the deterministic keep-reason order and the closed vocabulary (no Docker)
    $vocab = 'profile_probe,export_incomplete,stop_not_confirmed,record_not_saved,container_not_removed,run_not_normal,final_not_verified,volume_kind_mismatch,rm_failed'
    $order = (Get-VolumeKeepReasons)
    Test-Case 'G2 reasons: the closed vocabulary is exactly the nine codes (in the order of the decision)' ((@($order | Sort-Object) -join ',') -ceq ((($vocab -split ',') | Sort-Object) -join ',') -and ($order -join ',') -ceq 'profile_probe,stop_not_confirmed,export_incomplete,final_not_verified,run_not_normal,record_not_saved,container_not_removed,volume_kind_mismatch,rm_failed')
    $okExp = [pscustomobject]@{ Outcome = 'complete'; Location = 'x' }; $badExp = [pscustomobject]@{ Outcome = 'incomplete'; Location = 'x' }
    $r1 = Get-VolumeKeepReason -IsRun $false -StopConfirmed $false -Export $null -FinalVerified $false -Normal $false -RecordSaved $false -ContainerOutcome 'kept'
    $r2 = Get-VolumeKeepReason -IsRun $true -StopConfirmed $false -Export $null -FinalVerified $false -Normal $false -RecordSaved $false -ContainerOutcome 'kept'
    $r3 = Get-VolumeKeepReason -IsRun $true -StopConfirmed $true -Export $badExp -FinalVerified $false -Normal $false -RecordSaved $false -ContainerOutcome 'kept'
    $r3b = Get-VolumeKeepReason -IsRun $true -StopConfirmed $true -Export $null -FinalVerified $false -Normal $false -RecordSaved $false -ContainerOutcome 'kept'
    $r4 = Get-VolumeKeepReason -IsRun $true -StopConfirmed $true -Export $okExp -FinalVerified $false -Normal $false -RecordSaved $false -ContainerOutcome 'kept'
    $r5 = Get-VolumeKeepReason -IsRun $true -StopConfirmed $true -Export $okExp -FinalVerified $true -Normal $false -RecordSaved $false -ContainerOutcome 'kept'
    $r6 = Get-VolumeKeepReason -IsRun $true -StopConfirmed $true -Export $okExp -FinalVerified $true -Normal $true -RecordSaved $false -ContainerOutcome 'kept'
    $r7 = Get-VolumeKeepReason -IsRun $true -StopConfirmed $true -Export $okExp -FinalVerified $true -Normal $true -RecordSaved $true -ContainerOutcome 'kept'
    $r7b = Get-VolumeKeepReason -IsRun $true -StopConfirmed $true -Export $okExp -FinalVerified $true -Normal $true -RecordSaved $true -ContainerOutcome $null
    $rOkRemoved = Get-VolumeKeepReason -IsRun $true -StopConfirmed $true -Export $okExp -FinalVerified $true -Normal $true -RecordSaved $true -ContainerOutcome 'removed'
    $rOkAbsent = Get-VolumeKeepReason -IsRun $true -StopConfirmed $true -Export $okExp -FinalVerified $true -Normal $true -RecordSaved $true -ContainerOutcome 'absent'
    $rProv = Get-VolumeKeepReason -IsRun $true -StopConfirmed $true -Export $okExp -FinalVerified $true -Normal $true -Provisional
    Test-Case 'G2 reasons: with every condition wrong the first rule wins, and each rule shows up when the ones before it hold (probe, stop, export, final, normal, record, container)' ($r1 -ceq 'profile_probe' -and $r2 -ceq 'stop_not_confirmed' -and $r3 -ceq 'export_incomplete' -and $r3b -ceq 'export_incomplete' -and $r4 -ceq 'final_not_verified' -and $r5 -ceq 'run_not_normal' -and $r6 -ceq 'record_not_saved' -and $r7 -ceq 'container_not_removed' -and $r7b -ceq 'container_not_removed') "$r1 $r2 $r3 $r4 $r5 $r6 $r7"
    Test-Case 'G2 reasons: no reason when the container is removed or absent (the record and the other conditions hold); the provisional decision stops after rule 5' ($null -eq $rOkRemoved -and $null -eq $rOkAbsent -and $null -eq $rProv)

    # ---- a normal Run: the volume is removed after the container; the order, the locks, and the handles
    $script:g2Seen = @{}
    $g = Invoke-G2Run -Setup { param($f) $f.State.OnVolumeRm = { param($name, $s)
                $rid = $name -replace '^phoenix-run-', ''
                $script:g2Seen['Rec'] = Get-C2Record $script:g2Root $rid
                $script:g2Seen['ContainerGone'] = (@($s.Containers.Keys | Where-Object { $_ -like 'phoenix-discovery-*' }).Count -eq 0)
                $script:g2Seen['LockHeld'] = (Test-RunLockHeld $script:g2Root)
                $script:g2Seen['InputsHeld'] = (Test-InputsHeld $script:g2Root) } }
    $rec = $g.Rr.Rec; $seen = $script:g2Seen
    Test-Case 'G2 normal Run: exit 0, complete, the volume is removed, and the final record says removed (volumeCleanup removed with a null reason, removed_after_verified_export, container removed)' ($g.Res.ExitCode -eq 0 -and $g.Res.Code -ceq 'complete' -and -not $g.Fake.State.Volumes.ContainsKey($g.P.Volume) -and $rec['volumeDisposition'] -ceq 'removed_after_verified_export' -and $g.Rr.Text.Contains('"volumeCleanup":{"outcome":"removed","reason":null}') -and $rec['containerRemoval']['outcome'] -ceq 'removed' -and (Test-CompletedRun -Path $g.P.Final)) "code=$($g.Res.Code)"
    $iCopy = Get-CallIndex $g.Fake '*export-helper*'; $iCRm = Get-CallIndex $g.Fake 'rm id-*'; $iInsp = Get-CallIndex $g.Fake 'volume inspect --format*'; $iVRm = Get-CallIndex $g.Fake 'volume rm *'
    Test-Case 'G2 order: export copy, then the removal of the container, then the identity check of the volume, then the volume removal (one volume rm call)' ($iCopy -ge 0 -and $iCopy -lt $iCRm -and $iCRm -lt $iInsp -and $iInsp -lt $iVRm -and (Get-G2Calls $g.Fake 'volume rm*').Count -eq 1) "$iCopy $iCRm $iInsp $iVRm"
    Test-Case 'G2 order: when the volume is removed the provisional record is already saved (pending, kept_for_diagnosis, no final result yet) and the container is already gone' ($null -ne $seen['Rec'] -and $seen['Rec'].Rec['volumeCleanup']['outcome'] -ceq 'pending' -and $null -eq $seen['Rec'].Rec['volumeCleanup']['reason'] -and $seen['Rec'].Rec['volumeDisposition'] -ceq 'kept_for_diagnosis' -and $seen['Rec'].Rec['containerRemoval']['outcome'] -ceq 'pending' -and $seen['ContainerGone'] -eq $true)
    Test-Case 'G2 locks: at the volume removal the Run lock and the input file handles are still held; after the final record both are released' ($seen['LockHeld'] -eq $true -and $seen['InputsHeld'] -eq $true -and -not (Test-RunLockHeld $g.Root) -and (Test-InputsReleased $g.Root))
    $forceCalls = @($g.Fake.State.Calls | Where-Object { $_ -like 'volume rm*' -and ($_ -match '(^| )-f( |$)' -or $_ -match '--force') })
    $rmDef = (Get-Command Remove-RunVolume).Definition; $exportDef = (Get-Command Invoke-RunExport).Definition
    Test-Case 'G2 no force: the volume removal is a plain `volume rm <name>` (no -f, no --force) and the code has no force option' ($forceCalls.Count -eq 0 -and $g.Fake.State.Calls -contains "volume rm $($g.P.Volume)" -and -not ($rmDef -match "'-f'|'--force'"))
    Test-Case 'G2 export: Invoke-RunExport has no volume removal any more (static) and the old order is refused (the removal of the old step 8 would be made while the container exists)' (-not ($exportDef -match "'volume',\s*'rm'") -and -not ($exportDef -match 'volume rm'))
    # the negative control of the old order, on the fake itself: a volume that a stopped container references is not removed; after the container is removed it is
    $nr = New-TestRepo; $nf = Install-Fake $nr
    $nf.State.Volumes['phoenix-run-neg'] = (New-TempDir)
    $nf.State.Containers['phoenix-discovery-neg'] = @{ Running = $false; ExitCode = '0'; Labels = @{}; Mounts = @([ordered]@{ Type = 'volume'; Source = 'phoenix-run-neg'; Destination = '/run/out'; RW = $true }); Networks = @(); Polls = $null }
    $old1 = Invoke-DockerCli -Arguments @('volume', 'rm', 'phoenix-run-neg')
    $stillThere = $nf.State.Volumes.ContainsKey('phoenix-run-neg')
    [void](Invoke-DockerCli -Arguments @('rm', 'phoenix-discovery-neg'))
    $new1 = Invoke-DockerCli -Arguments @('volume', 'rm', 'phoenix-run-neg')
    Test-Case 'G2 negative control (fake Docker): the old order is refused (a stopped container still references the volume: exit 1, volume kept); after the container is removed the same call succeeds' ($old1.ExitCode -ne 0 -and $stillThere -and $new1.ExitCode -eq 0 -and -not $nf.State.Volumes.ContainsKey('phoenix-run-neg'))

    # ---- keep cases
    $g = Invoke-G2Run -Setup { param($f) $f.State.OnStart = { param($name, $s) $s.Containers[$name].Polls = $null }; $f.State.StopFails = $true }
    Test-Case 'G2 stop not confirmed: the volume and the container are kept, no volume call at all (no identity check, no removal), reason stop_not_confirmed, the retention of the locks and the input handles still holds, and the exit is non-zero' ($g.Res.ExitCode -ne 0 -and (Test-G2Kept $g 'stop_not_confirmed') -and (Get-G2Calls $g.Fake 'volume inspect --format*').Count -eq 0 -and $g.Fake.State.Containers.ContainsKey((Get-ContainerName -RunId $g.Res.RunId)) -and (Get-G2Calls $g.Fake 'rm id-*').Count -eq 0 -and (Test-UnstoppedRunRetained -RunId $g.Res.RunId) -and (Test-InputsHeld $g.Root) -and (Test-RunLockHeld $g.Root)) "exit=$($g.Res.ExitCode) code=$($g.Res.Code)"
    $g = Invoke-G2Run -Setup { param($f) $f.State.FailCopy = $true }
    Test-Case 'G2 export failure (copy): the volume is kept (export_incomplete); the container is kept because the evidence is not saved; no volume call' ((Test-G2Kept $g 'export_incomplete') -and $g.Rr.Rec['export']['step'] -ceq 'copy' -and $g.Rr.Rec['containerRemoval']['outcome'] -ceq 'kept' -and $g.Rr.Rec['containerRemoval']['reason'] -ceq 'evidence_not_saved' -and (Get-G2Calls $g.Fake 'volume inspect --format*').Count -eq 0 -and $g.Res.ExitCode -ne 0)
    $g = Invoke-G2Run -Seal $false
    Test-Case 'G2 export verification failure (no manifest): the volume is kept (export_incomplete); the Reason_File is saved, so the container is removed under the existing rule; the Run is not complete' ((Test-G2Kept $g 'export_incomplete') -and $g.Rr.Rec['export']['step'] -ceq 'verify' -and (Test-Path -LiteralPath (Join-Path $g.P.Export 'REASON.json')) -and -not $g.Fake.State.Containers.ContainsKey((Get-ContainerName -RunId $g.Res.RunId)) -and $g.Res.ExitCode -ne 0)
    $g = Invoke-G2Run -Setup { param($f) $f.State.OnCall = { param($call, $s) if ($call -like 'rm id-*') { $rid = $call.Substring('rm id-phoenix-discovery-'.Length); [IO.File]::WriteAllText((Join-Path $script:g2Root "discovery/runs/$rid/extra.txt"), 'x') } } }
    Test-Case 'G2 final location fails the re-verification before the removal (an unlisted file appears after the export): the volume is kept (final_not_verified), nothing of the final location is changed or removed by the Launcher, no volume call' ((Test-G2Kept $g 'final_not_verified') -and (Test-Path -LiteralPath (Join-Path $g.P.Final 'extra.txt')) -and -not (Test-CompletedRun -Path $g.P.Final) -and (Test-Path -LiteralPath (Join-Path $g.P.Final 'COMPLETE')) -and (Get-G2Calls $g.Fake 'volume inspect --format*').Count -eq 0)
    $g = Invoke-G2Run -Setup { param($f) $f.State.OnCreate = { param($name, $s) $rid = $name.Substring('phoenix-discovery-'.Length); foreach ($d in @('discovery/runs', 'discovery/runs/.incoming')) { $dd = Join-Path $script:g2Root $d; [void][IO.Directory]::CreateDirectory($dd); [void][IO.Directory]::CreateDirectory((Join-Path $dd "$rid.launcher.json.tmp")) } } }
    Test-Case 'G2 provisional record cannot be saved: no record exists, the container is kept (evidence not saved), the volume is kept and is not inspected or removed, the exit status is 1 launcher_record_not_saved (not complete), and the verified final location is untouched' ($null -eq $g.Rr -and $g.Res.ExitCode -eq 1 -and $g.Res.Code -ceq 'launcher_record_not_saved' -and $g.Fake.State.Volumes.ContainsKey($g.P.Volume) -and (Get-G2Calls $g.Fake 'volume inspect --format*').Count -eq 0 -and (Get-G2Calls $g.Fake 'volume rm*').Count -eq 0 -and $g.Fake.State.Containers.ContainsKey((Get-ContainerName -RunId $g.Res.RunId)) -and (Test-CompletedRun -Path $g.P.Final)) "exit=$($g.Res.ExitCode) code=$($g.Res.Code)"
    $g = Invoke-G2Run -Setup { param($f) $f.State.FailRm = $true }
    Test-Case 'G2 container removal fails: the container is kept (rm_failed) and the volume is kept (container_not_removed); no identity check and no removal of the volume' ((Test-G2Kept $g 'container_not_removed') -and $g.Rr.Rec['containerRemoval']['outcome'] -ceq 'kept' -and $g.Rr.Rec['containerRemoval']['reason'] -ceq 'rm_failed' -and (Get-G2Calls $g.Fake 'volume inspect --format*').Count -eq 0)
    $g = Invoke-G2Run -Setup { param($f) $f.State.OnStart = { param($name, $s) $c = $s.Containers[$name]; $vol = ($c.Mounts | Where-Object { $_.Destination -eq '/run/out' }).Source; [void](New-TestSealedRun -Dir $s.Volumes[$vol]); $s.VolumeLabels[$vol]['phoenix.discovery.run-id'] = 'run-20250101T000000Z-bbbbbbbbbbbb' } }
    Test-Case 'G2 volume identity: a run-id label of another Run keeps the volume (volume_kind_mismatch), the identity check was made, no volume rm' ((Test-G2Kept $g 'volume_kind_mismatch') -and (Get-G2Calls $g.Fake 'volume inspect --format*').Count -eq 1)
    $g = Invoke-G2Run -Setup { param($f) $f.State.OnStart = { param($name, $s) $c = $s.Containers[$name]; $vol = ($c.Mounts | Where-Object { $_.Destination -eq '/run/out' }).Source; [void](New-TestSealedRun -Dir $s.Volumes[$vol]); $s.VolumeLabels[$vol]['phoenix.discovery.volume-kind'] = 'probe-diagnostic' } }
    Test-Case 'G2 volume identity: another volume-kind label keeps the volume (volume_kind_mismatch), no volume rm' ((Test-G2Kept $g 'volume_kind_mismatch') -and (Get-G2Calls $g.Fake 'volume inspect --format*').Count -eq 1)
    $g = Invoke-G2Run -Setup { param($f) $f.State.OnStart = { param($name, $s) $c = $s.Containers[$name]; $vol = ($c.Mounts | Where-Object { $_.Destination -eq '/run/out' }).Source; [void](New-TestSealedRun -Dir $s.Volumes[$vol]); $s.VolumeLabels[$vol].Remove('phoenix.discovery.role') } }
    Test-Case 'G2 volume identity: a missing role label keeps the volume (volume_kind_mismatch), no volume rm' ((Test-G2Kept $g 'volume_kind_mismatch') -and (Get-G2Calls $g.Fake 'volume inspect --format*').Count -eq 1)
    $g = Invoke-G2Run -Setup { param($f) $f.State.OnCall = { param($call, $s) if ($call -like 'rm id-*') { [void]$s.Volumes.Remove('phoenix-run-' + $call.Substring('rm id-phoenix-discovery-'.Length)) } } }
    $gone = -not $g.Fake.State.Volumes.ContainsKey($g.P.Volume)
    Test-Case 'G2 volume already gone: the identity cannot be confirmed (volume_kind_mismatch); it is NEVER recorded as removed and no volume rm is made' ($gone -and $g.Rr.Rec['volumeCleanup']['outcome'] -ceq 'kept' -and $g.Rr.Rec['volumeCleanup']['reason'] -ceq 'volume_kind_mismatch' -and $g.Rr.Rec['volumeDisposition'] -ceq 'kept_for_diagnosis' -and (Get-G2Calls $g.Fake 'volume rm*').Count -eq 0)
    $g = Invoke-G2Run -Setup { param($f) $f.State.FailVolumeRm = $true }
    Test-Case 'G2 volume removal fails: the Run stays complete (exit 0), the volume is kept (rm_failed), one plain volume rm call, and no Docker text in the record' ($g.Res.ExitCode -eq 0 -and $g.Res.Code -ceq 'complete' -and (Test-G2Kept $g 'rm_failed' -RmCalls 1) -and -not $g.Rr.Text.Contains('in use') -and (Test-CompletedRun -Path $g.P.Final))
    $g = Invoke-G2Run -Profile 'probe' -Seal $false -Setup { param($f) $f.State.OnStart = { param($name, $s) $c = $s.Containers[$name]; $vol = ($c.Mounts | Where-Object { $_.Destination -eq '/run/out' }).Source; [IO.File]::WriteAllText((Join-Path $s.Volumes[$vol] 'probe-result.json'), '{"ok":true}') } }
    Test-Case 'G2 probe: the probe volume is kept (profile_probe), no volume inspect, no volume rm' ((Test-G2Kept $g 'profile_probe') -and (Get-G2Calls $g.Fake 'volume inspect --format*').Count -eq 0 -and $g.Rr.Rec['volumeRemoval'] -ceq 'requires_human_approval')
    $g = Invoke-G2Run -Setup { param($f) $f.State.RuntimeStderr = $utf8b.GetBytes('{"phase":"run","sealed":true,"terminationReason":"error"}' + "`n") }
    Test-Case 'G2 abnormal Run (export complete, sealed with termination error): the volume is kept (run_not_normal), the final location is kept and verified, the abnormal result (exit 1, runtime_sealed_abnormal) is unchanged, no volume rm' ($g.Res.ExitCode -eq 1 -and $g.Res.Code -ceq 'runtime_sealed_abnormal' -and (Test-G2Kept $g 'run_not_normal') -and (Test-CompletedRun -Path $g.P.Final) -and $g.Rr.Rec['containerRemoval']['outcome'] -ceq 'removed')
    $g = Invoke-G2Run -Setup { param($f) $f.State.ExitCodeOnEnd = '1' }
    Test-Case 'G2 abnormal Run (runtime exit code 1 with a complete export): the volume is kept (run_not_normal), the Launcher does not end as complete' ($g.Res.ExitCode -ne 0 -and (Test-G2Kept $g 'run_not_normal') -and (Test-CompletedRun -Path $g.P.Final))

    # ---- the final record cannot be written (state D)
    $script:g2Seen = @{}
    $g = Invoke-G2Run -Setup { param($f) $f.State.OnVolumeRm = { param($name, $s) $rid = $name -replace '^phoenix-run-', ''; $rp = Join-Path $script:g2Root "discovery/runs/$rid.launcher.json"; $script:g2Seen['Bytes'] = [IO.File]::ReadAllBytes($rp); [void][IO.Directory]::CreateDirectory("$rp.tmp"); $script:g2Seen['Complete'] = Get-Sha256HexOfFile -Path (Join-Path $script:g2Root "discovery/runs/$rid/COMPLETE") } }
    $recFile = Join-Path $g.P.Runs "$($g.Res.RunId).launcher.json"
    $provText = $utf8b.GetString([byte[]]$script:g2Seen['Bytes'])
    Test-Case 'G2 final record cannot be written: the Launcher does not end as complete (exit 1, launcher_record_not_saved), the provisional record stays byte-identical (pending, kept_for_diagnosis), and the removed volume is not created again' ($g.Res.ExitCode -eq 1 -and $g.Res.Code -ceq 'launcher_record_not_saved' -and (Test-BytesEqual ([IO.File]::ReadAllBytes($recFile)) ([byte[]]$script:g2Seen['Bytes'])) -and $provText.Contains('"volumeCleanup":{"outcome":"pending","reason":null}') -and $provText.Contains('"volumeDisposition":"kept_for_diagnosis"') -and -not $g.Fake.State.Volumes.ContainsKey($g.P.Volume) -and (Get-G2Calls $g.Fake 'volume create*').Count -eq 1) "exit=$($g.Res.ExitCode) code=$($g.Res.Code)"
    Test-Case 'G2 final record cannot be written: the verified final location is unchanged and still accepted, and the locks and the input file handles are released' ((Test-CompletedRun -Path $g.P.Final) -and (Get-Sha256HexOfFile -Path (Join-Path $g.P.Final 'COMPLETE')) -ceq $script:g2Seen['Complete'] -and -not (Test-RunLockHeld $g.Root) -and (Test-InputsReleased $g.Root))

    # ---- the Launcher ends at once (states A, B, C): the state on disk, and the existing recovery of the next start
    $killDir = New-TempDir; $killScript = Join-Path $killDir 'kill-child.ps1'
    [IO.File]::WriteAllText($killScript, $script:KillChild, $utf8)
    $libDir2 = Join-Path $PSScriptRoot 'lib'
    $readKv2 = { param($Out) $h = @{}; foreach ($ln in ($Out -split "`r?`n")) { if ($ln -match '^([a-z_0-9]+)=(.*)$') { $h[$Matches[1]] = $Matches[2] } }; $h }
    $states = @(
        @{ State = 'A (after the provisional record, before the container removal)'; At = 'before_container_removal'; Container = 'True'; Volume = 'True' },
        @{ State = 'B (after the container removal, before the volume removal)'; At = 'before_volume_removal'; Container = 'False'; Volume = 'True' },
        @{ State = 'C (after the volume removal, before the final record)'; At = 'after_volume_removal'; Container = 'False'; Volume = 'False' }
    )
    foreach ($ks in $states) {
        $kRoot = New-TestRepo
        $k = Invoke-ChildPwsh -ScriptPath $killScript -Arguments @('-Root', $kRoot, '-Tools', $script:ToolsDir, '-Lib', $libDir2, '-MutexName', (New-TestMutexName), '-KillAt', $ks.At) -TimeoutSec 300
        $kv = & $readKv2 $k.Output
        $recFiles = @(Get-ChildItem -LiteralPath (Join-Path $kRoot 'discovery/runs') -Filter '*.launcher.json' -ErrorAction SilentlyContinue)
        $kid = if ($recFiles.Count -eq 1) { $recFiles[0].Name -replace '\.launcher\.json$', '' } else { 'run-00000000T000000Z-000000000000' }
        $kr = if ($recFiles.Count -eq 1) { ConvertFrom-JsonStrict -Text ([IO.File]::ReadAllText($recFiles[0].FullName)) } else { $null }
        $kp = Get-RunPaths -RepoRoot $kRoot -RunId $kid
        Test-Case "G2 killed, state $($ks.State): the process ended at once (42); container exists = $($ks.Container), volume exists = $($ks.Volume); the provisional record is the only record (pending, kept_for_diagnosis, container removal pending); the final location is verified; the OS released the Run lock" ($k.ExitCode -eq 42 -and $kv['container_exists'] -ceq $ks.Container -and $kv['volume_exists'] -ceq $ks.Volume -and $null -ne $kr -and $kr['volumeCleanup']['outcome'] -ceq 'pending' -and $null -eq $kr['volumeCleanup']['reason'] -and $kr['volumeDisposition'] -ceq 'kept_for_diagnosis' -and $kr['containerRemoval']['outcome'] -ceq 'pending' -and (Test-CompletedRun -Path $kp.Final) -and -not (Test-RunLockHeld $kRoot)) "exit=$($k.ExitCode) $($k.Output -replace "`r?`n", ' ') $($k.Error)"
        # the next start: the existing recovery. A kept volume of a verified final location is not marked; nothing is repaired, changed, or removed.
        $kf = Install-Fake $kRoot
        if ($ks.Volume -ceq 'True') { $kf.State.Volumes["phoenix-run-$kid"] = (New-TempDir); $kf.State.VolumeLabels["phoenix-run-$kid"] = @{ 'phoenix.discovery.volume-kind' = 'run' } }
        if ($ks.Container -ceq 'True') { $kf.State.Containers["phoenix-discovery-$kid"] = @{ Running = $false; ExitCode = '0'; Labels = @{ 'phoenix.discovery.role' = 'runtime'; 'phoenix.discovery.run-id' = $kid }; Mounts = @(); Networks = @(); Polls = $null } }
        $hashBefore = @((Get-Sha256HexOfFile -Path (Join-Path $kp.Final 'COMPLETE')), (Get-Sha256HexOfFile -Path (Join-Path $kp.Final 'manifest.json')), (Get-Sha256HexOfFile -Path (Join-Path $kRoot "discovery/runs/$kid.launcher.json"))) -join ','
        $stoppedLeft = Stop-LeftoverRuntimeContainers
        $markedK = Set-InterruptedRuns -RepoRoot $kRoot
        $hashAfter = @((Get-Sha256HexOfFile -Path (Join-Path $kp.Final 'COMPLETE')), (Get-Sha256HexOfFile -Path (Join-Path $kp.Final 'manifest.json')), (Get-Sha256HexOfFile -Path (Join-Path $kRoot "discovery/runs/$kid.launcher.json"))) -join ','
        Test-Case "G2 recovery after state $($ks.State): no Run is marked interrupted, no Reason_File is written, the final location and the earlier record are byte-identical, and nothing is removed (no rm, no volume rm; the kept volume and the stopped container stay for a human decision)" (@($markedK).Count -eq 0 -and -not (Test-Path -LiteralPath (Join-Path $kp.Export 'REASON.json')) -and -not (Test-Path -LiteralPath (Join-Path $kp.Final 'REASON.json')) -and $hashBefore -ceq $hashAfter -and (Get-G2Calls $kf 'rm *').Count -eq 0 -and (Get-G2Calls $kf 'volume rm*').Count -eq 0 -and $kf.State.Volumes.ContainsKey("phoenix-run-$kid") -eq ($ks.Volume -ceq 'True') -and $kf.State.Containers.ContainsKey("phoenix-discovery-$kid") -eq ($ks.Container -ceq 'True'))
    }
    # a final location that no longer passes the reader acceptance follows the existing recovery (interrupted, volume kept)
    $kRoot = New-TestRepo; $kf = Install-Fake $kRoot
    $kid2 = New-DiscoveryRunId; $kp2 = Get-RunPaths -RepoRoot $kRoot -RunId $kid2
    $kf.State.Volumes[$kp2.Volume] = (New-TempDir); $kf.State.VolumeLabels[$kp2.Volume] = @{ 'phoenix.discovery.volume-kind' = 'run' }
    [void](New-TestSealedRun -Dir $kp2.Final); [IO.File]::WriteAllText((Join-Path $kp2.Final 'COMPLETE'), ('0' * 64))
    $markedT = Set-InterruptedRuns -RepoRoot $kRoot
    Test-Case 'G2 recovery: a final location that fails the reader acceptance is handled by the existing recovery (marked interrupted with a Reason_File in the Incoming_Export, volume kept, no removal)' (($markedT -contains $kid2) -and (Test-Path -LiteralPath (Join-Path $kp2.Export 'REASON.json')) -and $kf.State.Volumes.ContainsKey($kp2.Volume) -and (Get-G2Calls $kf 'volume rm*').Count -eq 0)
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

    # ================================================================ task 4.9-C2: the safety components wired into the Launcher (fake Docker)
    $digest = 'sha256:' + ('2' * 64)
    $normalLine = '{"phase":"run","sealed":true,"terminationReason":"iteration_limit_reached"}'
    $startDef = (Get-Command Invoke-DiscoveryStart).Definition

    # ---- A. refusals before the Run
    $argCases = @(
        @{ Name = 'no -AuditConfig'; Profile = 'run'; NoAudit = $true; Audit = ''; Code = 'audit_config_missing' },
        @{ Name = 'the value real'; Profile = 'run'; NoAudit = $false; Audit = 'real'; Code = 'audit_config_invalid' },
        @{ Name = 'the value Fixture (letter case)'; Profile = 'run'; NoAudit = $false; Audit = 'Fixture'; Code = 'audit_config_invalid' },
        @{ Name = 'the value FIXTURE (letter case)'; Profile = 'run'; NoAudit = $false; Audit = 'FIXTURE'; Code = 'audit_config_invalid' },
        @{ Name = 'an empty value'; Profile = 'run'; NoAudit = $false; Audit = ''; Code = 'audit_config_invalid' },
        @{ Name = 'a probe with -AuditConfig fixture'; Profile = 'probe'; NoAudit = $false; Audit = 'fixture'; Code = 'audit_config_with_probe' }
    )
    foreach ($ac in $argCases) {
        $root = New-TestRepo; $fake = Install-Fake $root
        $res = if ($ac.NoAudit) { Start-C2 -Root $root -Profile $ac.Profile -NoAudit } else { Start-C2 -Root $root -Profile $ac.Profile -Audit $ac.Audit }
        Test-Case "C2 arguments: $($ac.Name) is refused as $($ac.Code) (exit 2) before any Docker call, with no Run_Volume, Run directory, lease, or container" ($res.ExitCode -eq 2 -and $res.Code -ceq $ac.Code -and $fake.State.Calls.Count -eq 0 -and (Test-NoSideEffects (Get-SideEffects $fake $root))) "exit=$($res.ExitCode) code=$($res.Code) calls=$($fake.State.Calls.Count)"
    }
    $tk = $null; $er = $null; $eAst = [System.Management.Automation.Language.Parser]::ParseFile($entry, [ref]$tk, [ref]$er)
    $ap = @($eAst.ParamBlock.Parameters | Where-Object { $_.Name.VariablePath.UserPath -ceq 'AuditConfig' })
    $apAttrs = if ($ap.Count -eq 1) { @($ap[0].Attributes | ForEach-Object { $_.Extent.Text }) } else { @() }
    $entryNow = Get-Content -Raw -LiteralPath $entry
    Test-Case 'C2 entry point: -AuditConfig is a [string] with [ValidateSet(fixture)] only, not mandatory (no prompt), without a default, and passed on only when given' ($ap.Count -eq 1 -and $null -eq $ap[0].DefaultValue -and ($apAttrs -ccontains "[ValidateSet('fixture')]") -and ($apAttrs -ccontains '[string]') -and $apAttrs.Count -eq 2 -and -not ($entryNow -match 'Mandatory') -and $entryNow.Contains("if (`$PSBoundParameters.ContainsKey('AuditConfig')) { `$extra['AuditConfig'] = `$AuditConfig }") -and $entryNow.Contains("'discovery/locks/discovery-run.lock') @extra"))
    $inCases = @(
        @{ Name = 'the fixture audit-config.mock.json is missing'; Label = 'audit-config'; Code = 'missing'; Damage = { param($r) [IO.File]::Delete((Get-InputPath $r 'audit-config')) } },
        @{ Name = 'run-config.json is missing'; Label = 'run-config'; Code = 'missing'; Damage = { param($r) [IO.File]::Delete((Get-InputPath $r 'run-config')) } },
        @{ Name = 'a legacy source has a second hard link'; Label = 'legacy-src-orders'; Code = 'hard_linked'; Damage = { param($r) $fp = Get-InputPath $r 'legacy-src-orders'; New-Item -ItemType HardLink -Path ($fp + '.second') -Target $fp | Out-Null } },
        @{ Name = 'run-config.json is above 262144 bytes'; Label = 'run-config'; Code = 'too_large'; Damage = { param($r) [IO.File]::WriteAllBytes((Get-InputPath $r 'run-config'), [byte[]]::new(262145)) } }
    )
    foreach ($ic in $inCases) {
        $root = New-TestRepo; $fake = Install-Fake $root; & $ic.Damage $root
        $res = Start-C2 -Root $root -Audit 'fixture'
        $released = Test-InputsReleased $root
        $lk = Enter-RunLock -LockPath (Join-Path $root 'discovery/locks/discovery-run.lock')
        Test-Case "C2 input files: $($ic.Name) is refused after the gate and before the locks (input_file_refused, $($ic.Label):$($ic.Code), exit 2), with no Run_Volume, Run directory, lease, or container, and no handle left" ($res.ExitCode -eq 2 -and $res.Code -ceq 'input_file_refused' -and $res.InputFileLabel -ceq $ic.Label -and $res.InputFileCode -ceq $ic.Code -and (Test-NoSideEffects (Get-SideEffects $fake $root)) -and $released -and $null -ne $lk -and @($fake.State.Calls | Where-Object { $_ -like 'image inspect*' }).Count -eq 1) "exit=$($res.ExitCode) code=$($res.Code) $($res.InputFileLabel):$($res.InputFileCode)"
        if ($lk) { $lk.Dispose() }
    }
    Test-Case 'C2 lease D: Test-PropagationDelayValue accepts integers of 0 to 999999 only (main.ts PHOENIX_LEASE_D_MS ^[0-9]{1,6}$) and refuses 1000000, -1, 1.5, the text 5, and null' ((Test-PropagationDelayValue -Value ([long]0)) -and (Test-PropagationDelayValue -Value ([long]999999)) -and (Test-PropagationDelayValue -Value 50) -and -not (Test-PropagationDelayValue -Value ([long]1000000)) -and -not (Test-PropagationDelayValue -Value ([long]-1)) -and -not (Test-PropagationDelayValue -Value 1.5) -and -not (Test-PropagationDelayValue -Value '5') -and -not (Test-PropagationDelayValue -Value $null))
    $iGate = $startDef.IndexOf('Test-LaunchGate -RepoRoot'); $iD = $startDef.IndexOf('Test-PropagationDelayValue -Value $gate.Timing.D'); $iIn = $startDef.IndexOf('Open-InputFileGuard -RepoRoot'); $iLk = $startDef.IndexOf('Enter-DiscoveryLocks -MutexName'); $iAud = $startDef.IndexOf("`$AuditConfig -cne 'fixture'")
    Test-Case 'C2 order (static): arguments, then the gate, then D (lease_timing_d_invalid), then the input files, then the locks; lease.json is created by exactly one New-RunLease call' ($iAud -ge 0 -and $iAud -lt $iGate -and $iGate -lt $iD -and $iD -lt $iIn -and $iIn -lt $iLk -and $startDef.Contains("'lease_timing_d_invalid'") -and [regex]::Matches($startDef, 'New-RunLease ').Count -eq 1) "$iAud $iGate $iD $iIn $iLk"
    $root = New-TestRepo; $fake = Install-Fake $root
    $heldLock = Enter-RunLock -LockPath (Join-Path $root 'discovery/locks/discovery-run.lock')
    $res = Start-C2 -Root $root -Audit 'fixture'
    $releasedLock = Test-InputsReleased $root
    if ($heldLock) { $heldLock.Dispose() }
    Test-Case 'C2 locks: a held Run lock refuses the start (run_lock, exit 2) after the input check; no volume, lease, or container; the input file handles are released' ($null -ne $heldLock -and $res.Code -ceq 'run_lock' -and $res.ExitCode -eq 2 -and @($fake.State.Calls | Where-Object { $_ -like 'volume create*' -or $_ -like 'create *' }).Count -eq 0 -and -not (Test-Path -LiteralPath (Join-Path $root 'discovery/leases')) -and $releasedLock) "code=$($res.Code)"
    $root = New-TestRepo; $fake = Install-Fake $root
    $fake.State.Containers['leftover'] = @{ Running = $true; ExitCode = '0'; Labels = @{ 'phoenix.discovery.role' = 'runtime' }; Mounts = @(); Networks = @(); Polls = $null }
    $fake.State.StopFails = $true
    $res = Start-C2 -Root $root -Audit 'fixture'
    Test-Case 'C2 recovery: a recovery failure (recovery_failed, exit 3) creates no volume and releases the input file handles' ($res.Code -ceq 'recovery_failed' -and $res.ExitCode -eq 3 -and @($fake.State.Calls | Where-Object { $_ -like 'volume create*' }).Count -eq 0 -and (Test-InputsReleased $root)) "code=$($res.Code)"
    $root = New-TestRepo; $fake = Install-Fake $root; $fake.State.ThrowOn = 'volume create*'
    $threw = $false; try { [void](Start-C2 -Root $root -Audit 'fixture') } catch { $threw = $true }
    $lk = Enter-RunLock -LockPath (Join-Path $root 'discovery/locks/discovery-run.lock')
    Test-Case 'C2 exception: an exception after the locks (injected at volume create) still releases the input file handles and the Run lock' ($threw -and (Test-InputsReleased $root) -and $null -ne $lk)
    if ($lk) { $lk.Dispose() }

    # ---- B. creation, image, facts, inspection, re-check, start (a normal Run)
    $root = New-TestRepo; $fake = Install-Fake $root
    $script:c2Root = $root; $script:c2Seen = @{}
    $fake.State.Containers['phoenix-discovery-run-20250101T000000Z-eeeeeeeeeeee'] = @{ Running = $false; ExitCode = '0'; Labels = @{ 'phoenix.discovery.role' = 'runtime'; 'phoenix.discovery.run-id' = 'run-20250101T000000Z-eeeeeeeeeeee' }; Mounts = @(); Networks = @(); Polls = $null }
    $otherVol = 'phoenix-run-run-20250101T000000Z-eeeeeeeeeeee'; $fake.State.Volumes[$otherVol] = (New-TempDir)
    $fake.State.OnCreate = { param($name, $s) $ld = Get-LeaseDirOf $s.Containers[$name]; $script:c2Seen['leaseAtCreate'] = Test-Path -LiteralPath (Join-Path $ld 'lease.json'); $script:c2Seen['factsAtCreate'] = Test-Path -LiteralPath (Join-Path $ld 'launcher-facts.json'); $script:c2Seen['heldAtCreate'] = Test-InputsHeld $script:c2Root }
    $fake.State.OnStart = {
        param($name, $s)
        $c = $s.Containers[$name]; $ld = Get-LeaseDirOf $c; $fp = Join-Path $ld 'launcher-facts.json'
        if (Test-Path -LiteralPath $fp) { $script:c2Seen['factsAtStart'] = [IO.File]::ReadAllBytes($fp) }
        $script:c2Seen['attestationAtStart'] = Test-Path -LiteralPath (Join-Path $ld 'isolation-attestation.json')
        $script:c2Seen['heldAtStart'] = Test-InputsHeld $script:c2Root
        $vol = ($c.Mounts | Where-Object { $_.Destination -eq '/run/out' }).Source; [void](New-TestSealedRun -Dir $s.Volumes[$vol])
    }
    $script:c2Log = [System.Collections.Generic.List[string]]::new()
    $res = Start-C2 -Root $root -Audit 'fixture' -Log { param($m) $script:c2Log.Add([string]$m) }
    $rr = Get-C2Record $root $res.RunId; $rec = $rr.Rec
    $createCall = @($fake.State.Calls | Where-Object { $_ -like 'create *' })[0]
    Test-Case 'C2 create: the Run container is created from the image ID of the gate with --pull never (never the tag), as the last arguments' ($createCall.EndsWith(" --pull never $digest") -and -not $createCall.Contains('phoenix/discovery-runtime:m4') -and @($fake.State.Calls | Where-Object { $_ -like 'pull *' }).Count -eq 0) $createCall
    $bind = @{}; foreach ($m in [regex]::Matches($createCall, '--mount type=bind,source=([^,]+),target=([^, ]+)(,readonly)?')) { $bind[$m.Groups[2].Value] = @($m.Groups[1].Value, ($m.Groups[3].Value -ceq ',readonly')) }
    $mountBad = @(); $tbl = Get-InputFileTable
    foreach ($row in $tbl) { $want = [IO.Path]::GetFullPath((Join-Path $root ($row.RelPath -replace '/', '\'))); if (-not $bind.ContainsKey($row.Target) -or -not [string]::Equals($bind[$row.Target][0], $want, 'OrdinalIgnoreCase') -or -not $bind[$row.Target][1]) { $mountBad += $row.Label } }
    $oldAudit = [IO.Path]::GetFullPath((Join-Path $root 'discovery\config\audit-config.json'))
    Test-Case 'C2 mounts: each of the 11 checked input files is bind-mounted read-only from its checked path at its table target (the audit target from audit-config.mock.json); the lease directory is the only other bind mount; the old audit-config.json is no source' ($mountBad.Count -eq 0 -and $bind.Count -eq 12 -and $bind.ContainsKey('/run/lease') -and $bind['/run/lease'][1] -and @($bind.Values | Where-Object { [string]::Equals($_[0], $oldAudit, 'OrdinalIgnoreCase') }).Count -eq 0 -and $createCall.Contains("type=volume,source=phoenix-run-$($res.RunId),target=/run/out")) ($mountBad -join ',')
    $iVol = Get-CallIndex $fake 'volume create*'; $iCr = Get-CallIndex $fake 'create *'; $iImg = Get-CallIndex $fake 'inspect --format {{.Image}}|*'; $iMnt = Get-CallIndex $fake 'inspect --format {{json .Mounts}}*'; $iSt = Get-CallIndex $fake 'start *'; $iLogs = Get-CallIndex $fake 'logs *'; $iCopy = Get-CallIndex $fake '*export-helper*'
    Test-Case 'C2 order: volume, create (lease.json present, no facts yet, files held), image of the created container, mount inspection, start (facts and attestation present, files held), then after the end the logs, then the export copy' ($iVol -lt $iCr -and $iCr -lt $iImg -and $iImg -lt $iMnt -and $iMnt -lt $iSt -and $iSt -lt $iLogs -and $iLogs -lt $iCopy -and $iVol -ge 0 -and $script:c2Seen['leaseAtCreate'] -eq $true -and $script:c2Seen['factsAtCreate'] -eq $false -and $script:c2Seen['heldAtCreate'] -eq $true -and $null -ne $script:c2Seen['factsAtStart'] -and $script:c2Seen['attestationAtStart'] -eq $true -and $script:c2Seen['heldAtStart'] -eq $true) "$iVol $iCr $iImg $iMnt $iSt $iLogs $iCopy"
    $auditSha = (Get-FileHash -LiteralPath (Get-InputPath $root 'audit-config') -Algorithm SHA256).Hash.ToLowerInvariant()
    $factsBytes = [byte[]]$script:c2Seen['factsAtStart']
    $fv = Test-LauncherFactsBytes -Bytes $factsBytes -ExpectedRunId $res.RunId -ExpectedAuditConfigSha256 $auditSha
    $fkeys = @((ConvertFrom-JsonStrict -Text ([System.Text.UTF8Encoding]::new($false).GetString($factsBytes))).Keys | Sort-Object)
    Test-Case 'C2 facts: launcher-facts.json v2 at start has exactly the six keys, the run id, the image ID of the created container, the SHA-256 of the bytes of audit-config.mock.json, and the kind fixture' ($fv.Ok -and $fv.Values.RuntimeImageId -ceq $digest -and $fv.Values.AuditConfigKind -ceq 'fixture' -and ($fkeys -join ',') -ceq 'audit_config_kind,audit_config_sha256,issued_by,run_id,runtime_image_id,schema_version') "code=$($fv.Code)"
    $nonceArg = [regex]::Match($createCall, 'PHOENIX_LEASE_NONCE=([0-9a-f]+)').Groups[1].Value
    Test-Case 'C2 record: the facts (written, the file hash, the two Launcher declarations), the image match, the audit configuration (switch, relative path, hash) and the run configuration hash are recorded, with relative paths only and no nonce' ($rec['launcherFacts']['outcome'] -ceq 'written' -and $rec['launcherFacts']['sha256'] -ceq (Get-Sha256Hex -Bytes $factsBytes) -and (@($rec['launcherFacts']['declaredByLauncher']) -join ',') -ceq 'audit_config_kind,runtime_image_id' -and $rec['runtimeImage']['match'] -eq $true -and $rec['runtimeImage']['createdContainerImageId'] -ceq $digest -and $rec['auditConfig']['switch'] -ceq 'fixture' -and $rec['auditConfig']['relPath'] -ceq 'discovery/config/audit-config.mock.json' -and $rec['auditConfig']['sha256'] -ceq $auditSha -and $rec['runConfig']['sha256'] -ceq (Get-FileHash -LiteralPath (Get-InputPath $root 'run-config') -Algorithm SHA256).Hash.ToLowerInvariant() -and @($rec['inputFiles']).Count -eq 11 -and $rec['inputFileRecheck']['ok'] -eq $true -and $nonceArg.Length -eq 32 -and -not $rr.Text.Contains($nonceArg) -and -not $rr.Text.Contains($root) -and -not (($script:c2Log -join "`n").Contains($nonceArg)))
    Test-Case 'C2 end (normal): a normal sealed end with a complete export is complete (exit 0); the record has the runtime report (runtime_sealed_normal, consistent, trusted values, not an independent verification, purpose not assessed) and the result; the handles are released' ($res.ExitCode -eq 0 -and $res.Code -ceq 'complete' -and $rec['runtimeReport']['classification'] -ceq 'runtime_sealed_normal' -and $rec['runtimeReport']['consistency'] -ceq 'consistent' -and $rec['runtimeReport']['completeEligible'] -eq $true -and $rec['runtimeReport']['values']['trusted'] -eq $true -and $rec['runtimeReport']['values']['terminationReason'] -ceq 'iteration_limit_reached' -and $rec['runtimeReport']['independentVerification'] -eq $false -and $rec['runtimeReport']['purposeAssessment'] -ceq 'not_assessed' -and $rec['launcherResult']['code'] -ceq 'complete' -and $rec['launcherResult']['purposeAssessment'] -ceq 'not_assessed' -and $rec['inputFileHandles'] -ceq 'released_after_stop' -and (Test-InputsReleased $root) -and (Test-CompletedRun -Path (Get-RunPaths -RepoRoot $root -RunId $res.RunId).Final)) "code=$($res.Code)"
    Test-Case 'C2 other Runs: the container and the volume of another Run are not removed (no rm, no volume rm of them); only this Run''s container is removed' ($fake.State.Containers.ContainsKey('phoenix-discovery-run-20250101T000000Z-eeeeeeeeeeee') -and $fake.State.Volumes.ContainsKey($otherVol) -and @($fake.State.Calls | Where-Object { $_ -like '*eeeeeeeeeeee*' -and ($_ -like 'rm *' -or $_ -like 'volume rm *') }).Count -eq 0 -and @($fake.State.Calls | Where-Object { $_ -like 'rm *' }).Count -eq 1)

    # ---- B. refusals between create and start: no start, nothing of another Run touched, handles released
    $refCases = @(
        @{ Name = 'docker create fails'; Code = 'container_create_failed'; Setup = { param($f) $f.State.FailCreate = $true }; Facts = $false },
        @{ Name = 'the image of the created container cannot be read'; Code = 'image_inspect_failed'; Setup = { param($f) $f.State.ImageInspectFails = $true }; Facts = $false },
        @{ Name = 'the created container has another image ID'; Code = 'runtime_image_mismatch'; Setup = { param($f) $f.State.ImageOverride = 'sha256:' + ('3' * 64) }; Facts = $false },
        @{ Name = 'the created container has another Run identifier label'; Code = 'container_identity_mismatch'; Setup = { param($f) $f.State.LabelRunIdOverride = 'run-20250101T000000Z-dddddddddddd' }; Facts = $false },
        @{ Name = 'a launcher-facts.json already exists (exclusive creation refuses it and leaves it unchanged)'; Code = 'launcher_facts_failed'; Setup = { param($f) $f.State.OnCreate = { param($name, $s) [IO.File]::WriteAllText((Join-Path (Get-LeaseDirOf $s.Containers[$name]) 'launcher-facts.json'), 'foreign') } }; Facts = $true },
        @{ Name = 'the mount inspection fails'; Code = 'mount_inspection_failed'; Setup = { param($f) $f.State.ExtraMount = [ordered]@{ Type = 'bind'; Source = 'C:\other'; Destination = '/other'; RW = $false } }; Facts = $true },
        @{ Name = 'a held input file gets a hard link before the start (identity re-check)'; Code = 'input_file_changed'; Setup = { param($f) $f.State.OnCreate = { param($name, $s) $fp = Get-InputPath $script:c2Root 'legacy-src-db'; New-Item -ItemType HardLink -Path ($fp + '.second') -Target $fp | Out-Null } }; Facts = $true }
    )
    foreach ($rc in $refCases) {
        $root = New-TestRepo; $fake = Install-Fake $root; $script:c2Root = $root
        & $rc.Setup $fake
        $res = Start-C2 -Root $root -Audit 'fixture'
        $pp = Get-RunPaths -RepoRoot $root -RunId $res.RunId
        $factsThere = Test-Path -LiteralPath (Join-Path $pp.Lease 'launcher-facts.json')
        $reason = Get-ReasonText $root $res.RunId
        $rcRec = Get-C2Record $root $res.RunId
        $extraOk = switch ($rc.Code) {
            'launcher_facts_failed' { ([IO.File]::ReadAllText((Join-Path $pp.Lease 'launcher-facts.json')) -ceq 'foreign') -and $rcRec.Rec['launcherFacts']['code'] -ceq 'exists' }
            'input_file_changed' { $rcRec.Rec['inputFileRecheck']['code'] -ceq 'hard_linked' -and $rcRec.Rec['inputFileRecheck']['label'] -ceq 'legacy-src-db' }
            'runtime_image_mismatch' { $rcRec.Rec['runtimeImage']['match'] -eq $false }
            default { $true }
        }
        Test-Case "C2 refusal: $($rc.Name) gives $($rc.Code) (exit 3) and no docker start; the facts file is $(if ($rc.Facts) { 'there (written before)' } else { 'absent' }); the lease is revoked; the Reason_File keeps its step and names the Launcher code; the handles and the Run lock are released" ($res.ExitCode -eq 3 -and $res.Code -ceq $rc.Code -and @($fake.State.Calls | Where-Object { $_ -like 'start *' }).Count -eq 0 -and $factsThere -eq $rc.Facts -and (Test-Path -LiteralPath (Join-Path $pp.Lease 'revoked')) -and $null -ne $reason -and (ConvertFrom-JsonStrict -Text $reason)['step'] -ceq 'verify' -and $reason.Contains("launcher=$($rc.Code)") -and (Test-InputsReleased $root) -and $null -ne ($lkR = Enter-RunLock -LockPath (Join-Path $root 'discovery/locks/discovery-run.lock')) -and $extraOk) "exit=$($res.ExitCode) code=$($res.Code) facts=$factsThere"
        if ($lkR) { $lkR.Dispose(); $lkR = $null }
    }

    # ---- C. the end of the runtime: the report and the Launcher outcome
    $pad = { param([int]$Total) $head = '{"phase":"run","sealed":true,"terminationReason":"iteration_limit_reached"'; $head + (' ' * ($Total - $head.Length - 2)) + '}' + "`n" }
    $endCases = @(
        @{ Name = 'a normal sealed end whose export fails (copy failure)'; Text = ($normalLine + "`n"); Exit = '0'; Seal = $true; Copy = $false; Logs = ''; Class = 'runtime_sealed_normal'; ReportCode = $null; Code = 'ended'; ExportComplete = $false },
        @{ Name = 'error with a sealed manifest'; Text = ('{"phase":"run","sealed":true,"terminationReason":"error"}' + "`n"); Exit = '0'; Seal = $true; Copy = $true; Logs = ''; Class = 'runtime_sealed_abnormal'; ReportCode = $null; Code = 'runtime_sealed_abnormal'; ExportComplete = $true },
        @{ Name = 'runtime exit 1 (not sealed)'; Text = ('{"phase":"run","sealed":false,"started":true,"failure":"seal_failed"}' + "`n"); Exit = '1'; Seal = $false; Copy = $true; Logs = ''; Class = 'runtime_unsealed'; ReportCode = $null; Code = 'runtime_unsealed'; ExportComplete = $false },
        @{ Name = 'runtime exit 2 (stage B refusal)'; Text = ('{"phase":"stage_b","refusals":[{"check":"lease","code":"lease_invalid"}]}' + "`n"); Exit = '2'; Seal = $false; Copy = $true; Logs = ''; Class = 'runtime_refused'; ReportCode = $null; Code = 'runtime_refused'; ExportComplete = $false },
        @{ Name = 'an unexpected runtime exit code 137'; Text = ($normalLine + "`n"); Exit = '137'; Seal = $true; Copy = $true; Logs = ''; Class = 'runtime_exit_unexpected'; ReportCode = $null; Code = 'runtime_exit_unexpected'; ExportComplete = $true },
        @{ Name = 'a sealed line with exit code 1 (inconsistent)'; Text = ($normalLine + "`n"); Exit = '1'; Seal = $true; Copy = $true; Logs = ''; Class = 'runtime_report_inconsistent'; ReportCode = $null; Code = 'runtime_report_inconsistent'; ExportComplete = $true },
        @{ Name = 'no standard error line'; Text = ''; Exit = '0'; Seal = $true; Copy = $true; Logs = ''; Class = 'runtime_report_invalid'; ReportCode = 'report_absent'; Code = 'runtime_report_invalid'; ExportComplete = $true },
        @{ Name = 'a line that is not JSON'; Text = ("Error: boom`n"); Exit = '0'; Seal = $true; Copy = $true; Logs = ''; Class = 'runtime_report_invalid'; ReportCode = 'report_not_json'; Code = 'runtime_report_invalid'; ExportComplete = $true },
        @{ Name = 'an unknown termination reason'; Text = ('{"phase":"run","sealed":true,"terminationReason":"goal_reached"}' + "`n"); Exit = '0'; Seal = $true; Copy = $true; Logs = ''; Class = 'runtime_report_invalid'; ReportCode = 'report_value_invalid'; Code = 'runtime_report_invalid'; ExportComplete = $true },
        @{ Name = 'two lines'; Text = ($normalLine + "`n" + $normalLine + "`n"); Exit = '0'; Seal = $true; Copy = $true; Logs = ''; Class = 'runtime_report_invalid'; ReportCode = 'report_not_single_line'; Code = 'runtime_report_invalid'; ExportComplete = $true },
        @{ Name = 'exactly 8192 bytes (the bound)'; Text = (& $pad 8192); Exit = '0'; Seal = $true; Copy = $true; Logs = ''; Class = 'runtime_sealed_normal'; ReportCode = $null; Code = 'complete'; ExportComplete = $true },
        @{ Name = '8193 bytes (above the bound)'; Text = (& $pad 8193); Exit = '0'; Seal = $true; Copy = $true; Logs = ''; Class = 'runtime_report_invalid'; ReportCode = 'report_too_large'; Code = 'runtime_report_invalid'; ExportComplete = $true },
        @{ Name = 'docker logs fails'; Text = ($normalLine + "`n"); Exit = '0'; Seal = $true; Copy = $true; Logs = 'fail'; Class = 'runtime_report_invalid'; ReportCode = 'logs_unavailable'; Code = 'runtime_report_invalid'; ExportComplete = $true },
        @{ Name = 'docker logs times out'; Text = ($normalLine + "`n"); Exit = '0'; Seal = $true; Copy = $true; Logs = 'timeout'; Class = 'runtime_report_invalid'; ReportCode = 'logs_unavailable'; Code = 'runtime_report_invalid'; ExportComplete = $true }
    )
    foreach ($ec in $endCases) {
        $root = New-TestRepo; $fake = Install-Fake $root
        $fake.State.RuntimeStderr = [System.Text.UTF8Encoding]::new($false).GetBytes([string]$ec.Text)
        $fake.State.ExitCodeOnEnd = $ec.Exit
        if ($ec.Seal) { $fake.State.OnStart = $sealed }
        if (-not $ec.Copy) { $fake.State.FailCopy = $true }
        if ($ec.Logs -ceq 'fail') { $fake.State.LogsFail = $true }
        if ($ec.Logs -ceq 'timeout') { $fake.State.LogsTimeout = $true }
        $res = Start-C2 -Root $root -Audit 'fixture'
        $er = Get-C2Record $root $res.RunId; $rep = $er.Rec['runtimeReport']
        $pp = Get-RunPaths -RepoRoot $root -RunId $res.RunId
        $exportOk = (Test-Path -LiteralPath $pp.Final) -and (Test-CompletedRun -Path $pp.Final)
        $reason = Get-ReasonText $root $res.RunId
        $reasonOk = if ($exportOk) { $null -eq $reason } else { $null -ne $reason -and (ConvertFrom-JsonStrict -Text $reason)['detail'].Contains("runtime_classification=$($ec.Class)") }
        $expExit = if ($ec.Code -ceq 'complete') { 0 } else { 1 }
        $capOk = switch ($ec.Logs) { 'timeout' { $rep['capture']['timedOut'] -eq $true -and $rep['capture']['stderrExceeded'] -eq $false } 'fail' { $rep['capture']['cliExitCode'] -ne 0 } default { $true } }
        if ($ec.ReportCode -ceq 'report_too_large') { $capOk = $rep['capture']['stderrExceeded'] -eq $true -and $rep['capture']['stderrBytes'] -eq 8193 -and $rep['capture']['timedOut'] -eq $false }
        if ($ec.Code -ceq 'complete') { $capOk = $capOk -and $rep['capture']['stderrBytes'] -eq 8192 -and $rep['capture']['stderrExceeded'] -eq $false }
        if ($ec.Class -ceq 'runtime_report_inconsistent') { $capOk = $capOk -and $rep['values']['trusted'] -eq $false -and $rep['consistency'] -ceq 'inconsistent' }
        if ($null -ne $ec.ReportCode) { $capOk = $capOk -and -not $rep.Contains('values') }
        Test-Case "C2 runtime end: $($ec.Name) gives $($ec.Code) (exit $expExit), classification $($ec.Class)$(if ($ec.ReportCode) { ", report code $($ec.ReportCode)" }), export complete = $($ec.ExportComplete), complete only when eligible AND exported; the Reason_File (if any) keeps its step and names the classification" ($res.Code -ceq $ec.Code -and $res.ExitCode -eq $expExit -and $rep['classification'] -ceq $ec.Class -and ($null -eq $ec.ReportCode -or $rep['reportCode'] -ceq $ec.ReportCode) -and $exportOk -eq $ec.ExportComplete -and $er.Rec['launcherResult']['code'] -ceq $ec.Code -and $rep['purposeAssessment'] -ceq 'not_assessed' -and ($rep['completeEligible'] -eq ($ec.Class -ceq 'runtime_sealed_normal')) -and $reasonOk -and $capOk -and (Test-InputsReleased $root)) "code=$($res.Code) class=$($rep['classification']) reportCode=$($rep['reportCode']) export=$exportOk"
    }
    # no raw text of the runtime or of Docker, and no nonce, in the record, the Reason_File, the log, or the result
    $marker = 'SECRET-MARKER-C2-7f3a'
    $root = New-TestRepo; $fake = Install-Fake $root
    $fake.State.RuntimeStderr = [System.Text.UTF8Encoding]::new($false).GetBytes('{"phase":"run","sealed":false,"started":true,"failure":"' + $marker + '"}' + "`n")
    $fake.State.ExitCodeOnEnd = '1'
    $script:c2Log = [System.Collections.Generic.List[string]]::new()
    $res = Start-C2 -Root $root -Audit 'fixture' -Log { param($m) $script:c2Log.Add([string]$m) }
    $lr = Get-C2Record $root $res.RunId; $reason = Get-ReasonText $root $res.RunId
    $nonceArg = [regex]::Match(@($fake.State.Calls | Where-Object { $_ -like 'create *' })[0], 'PHOENIX_LEASE_NONCE=([0-9a-f]+)').Groups[1].Value
    $everything = $lr.Text + "`n" + [string]$reason + "`n" + ($script:c2Log -join "`n") + "`n" + (ConvertTo-Json -InputObject $res -Depth 8)
    Test-Case 'C2 no leak: a refused line with a marker value leaves neither the marker nor the nonce in the Launcher record, the Reason_File, the log, or the result; the report is refused (report_value_invalid)' ($lr.Rec['runtimeReport']['reportCode'] -ceq 'report_value_invalid' -and $nonceArg.Length -eq 32 -and -not $everything.Contains($marker) -and -not $everything.Contains($nonceArg) -and $null -ne $reason)

    # ---- D. the probe is unchanged
    $root = New-TestRepo; $fake = Install-Fake $root
    $res = Start-Test -Root $root -Profile 'probe'
    $pc = @($fake.State.Calls | Where-Object { $_ -like 'create *' })[0]
    $prr = Get-C2Record $root $res.RunId; $ppp = Get-RunPaths -RepoRoot $root -RunId $res.RunId
    Test-Case 'C2 probe: a probe takes no audit configuration, is created from the toolchain tag without --pull, reads no created image, writes no launcher-facts.json, takes no runtime report, and holds no input file' ($pc.Contains(' phoenix/discovery-toolchain:m0 node ') -and -not $pc.Contains('--pull') -and @($fake.State.Calls | Where-Object { $_ -like 'inspect --format {{.Image}}*' -or $_ -like 'logs *' }).Count -eq 0 -and -not (Test-Path -LiteralPath (Join-Path $ppp.Lease 'launcher-facts.json')) -and -not $prr.Rec.Contains('runtimeReport') -and -not $prr.Rec.Contains('auditConfig') -and -not $prr.Rec.Contains('inputFileHandles') -and (Test-InputsReleased $root))

    # ---- E. the bounded capture of the Docker invoker (D5), with a pwsh child process that is NOT Docker
    $emitDir = New-TempDir; $emit = Join-Path $emitDir 'emit.ps1'; [IO.File]::WriteAllText($emit, $script:EmitScript, $utf8)
    $e1 = Invoke-Emit $emit @('-Err', '8192')
    Test-Case 'bounded: exactly 8192 bytes on standard error are kept whole (not exceeded, not killed, exit 0, process gone, streams drained)' ($e1.R.Stderr.Length -eq 8192 -and (Test-AllBytes $e1.R.Stderr 0x65) -and -not $e1.R.StderrExceeded -and -not $e1.R.Killed -and -not $e1.R.TimedOut -and $e1.R.ExitCode -eq 0 -and $e1.R.Exited -and $e1.R.StreamsDrained -and $e1.Gone) "len=$($e1.R.Stderr.Length) ex=$($e1.R.StderrExceeded) exit=$($e1.R.ExitCode)"
    $e2 = Invoke-Emit $emit @('-Err', '8193', '-Sleep', '20000')
    Test-Case 'bounded: 8193 bytes on standard error exceed the bound WHILE reading: the still-running child is killed at once (well before its 20 s sleep), 8193 bytes kept, flagged, the process is gone' ($e2.R.StderrExceeded -and $e2.R.Stderr.Length -eq 8193 -and $e2.R.Killed -and -not $e2.R.TimedOut -and $e2.R.Exited -and $e2.R.StreamsDrained -and $e2.Gone -and $e2.Ms -lt 15000) "ms=$($e2.Ms) len=$($e2.R.Stderr.Length)"
    $e3 = Invoke-Emit $emit @('-Out', '8193', '-Sleep', '20000')
    Test-Case 'bounded: the bound works on standard output too (8193 bytes: exceeded, killed, standard error empty)' ($e3.R.StdoutExceeded -and -not $e3.R.StderrExceeded -and $e3.R.Stdout.Length -eq 8193 -and $e3.R.Stderr.Length -eq 0 -and $e3.R.Killed -and $e3.Gone -and $e3.Ms -lt 15000) "ms=$($e3.Ms)"
    $e4 = Invoke-Emit $emit @('-Err', '20000000', '-Out', '100')
    Test-Case 'bounded: a flood of 20 MB on standard error does not deadlock: exceeded, killed, quick' ($e4.R.StderrExceeded -and $e4.R.Killed -and -not $e4.R.TimedOut -and $e4.Gone -and $e4.Ms -lt 15000) "ms=$($e4.Ms)"
    $e5 = Invoke-Emit $emit @('-Out', '20000000', '-Err', '100')
    Test-Case 'bounded: a flood of 20 MB on standard output does not deadlock: exceeded, killed, quick' ($e5.R.StdoutExceeded -and $e5.R.Killed -and -not $e5.R.TimedOut -and $e5.Gone -and $e5.Ms -lt 15000) "ms=$($e5.Ms)"
    $e6 = Invoke-Emit $emit @('-Out', '20000000', '-Err', '20000000', '-Interleave', '65536')
    Test-Case 'bounded: floods on both streams at the same time do not deadlock: a stream is exceeded, the child is killed, quick' (($e6.R.StdoutExceeded -or $e6.R.StderrExceeded) -and $e6.R.Killed -and -not $e6.R.TimedOut -and $e6.Gone -and $e6.Ms -lt 15000) "ms=$($e6.Ms)"
    $e7 = Invoke-Emit $emit @('-Out', '8000', '-Err', '8000', '-Interleave', '500')
    Test-Case 'bounded: both streams written alternately (8000 bytes each) are read independently and completely' ($e7.R.Stdout.Length -eq 8000 -and $e7.R.Stderr.Length -eq 8000 -and (Test-AllBytes $e7.R.Stdout 0x6F) -and (Test-AllBytes $e7.R.Stderr 0x65) -and -not $e7.R.StdoutExceeded -and -not $e7.R.StderrExceeded -and $e7.R.ExitCode -eq 0 -and $e7.Gone) "out=$($e7.R.Stdout.Length) err=$($e7.R.Stderr.Length)"
    $e8 = Invoke-Emit $emit @('-Invalid')
    Test-Case 'bounded: invalid UTF-8 bytes are returned exactly as written (no replacement) and the parser then refuses them as report_not_utf8' ((Test-BytesEqual $e8.R.Stderr ([byte[]](0x7B, 0xFF, 0xC0, 0xAF, 0xED, 0xA0, 0x80, 0x7D, 0x0A))) -and (ConvertFrom-RuntimeReport -Bytes $e8.R.Stderr -ExitCode 0).ReportCode -ceq 'report_not_utf8')
    $e9 = Invoke-Emit $emit @('-Sleep', '60000') -TimeoutMs 1500
    Test-Case 'bounded: a child that runs past the time limit is TimedOut (not exceeded), killed, reaped, and its streams drained, well before its 60 s sleep' ($e9.R.TimedOut -and -not $e9.R.StdoutExceeded -and -not $e9.R.StderrExceeded -and $e9.R.Killed -and $e9.R.Exited -and $e9.R.StreamsDrained -and $e9.Gone -and $e9.Ms -lt 15000) "ms=$($e9.Ms)"
    $e10 = Invoke-Emit $emit @('-Err', '10', '-Exit', '7')
    Test-Case 'bounded: the exit code of the child is passed through (7)' ($e10.R.ExitCode -eq 7 -and $e10.R.Stderr.Length -eq 10 -and -not $e10.R.Killed)
    $root = New-TestRepo; $fake = Install-Fake $root
    $bads = @(
        { param([string[]]$Arguments, $Capture) [pscustomobject]@{ ExitCode = 0; Output = ''; Error = '' } },
        { param([string[]]$Arguments, $Capture) [pscustomobject]@{ ExitCode = 0; Stdout = [byte[]]@(); Stderr = 'text'; StdoutExceeded = $false; StderrExceeded = $false; TimedOut = $false; Exited = $true; StreamsDrained = $true } },
        { param([string[]]$Arguments, $Capture) [pscustomobject]@{ ExitCode = 0; Stdout = [byte[]]@(); Stderr = [byte[]]@(1); StdoutExceeded = $false; StderrExceeded = $false; TimedOut = $false; Exited = $true; StreamsDrained = $false } },
        { param([string[]]$Arguments, $Capture) [pscustomobject]@{ ExitCode = 0; Stdout = [byte[]]@(); Stderr = [byte[]]::new(9000); StdoutExceeded = $false; StderrExceeded = $false; TimedOut = $false; Exited = $true; StreamsDrained = $true } },
        { param([string[]]$Arguments, $Capture) throw 'boom' }
    )
    $badValid = @(); foreach ($b in $bads) { Set-DockerCliInvoker -Invoker $b; $badValid += (Invoke-DockerCliCapture -Arguments @('logs', 'x') -LimitBytes 8192 -TimeoutMs 1000).Valid }
    Set-DockerCliInvoker -Invoker $fake.Invoker
    Test-Case 'bounded: a capture answer that is not the bounded shape (no bytes, text instead of bytes, streams not drained, more than limit + 1 bytes, an exception) is invalid and never used' (@($badValid | Where-Object { $_ }).Count -eq 0 -and $badValid.Count -eq 5)
    $plain = Invoke-DockerCli -Arguments @('version', '--format', '{{.Server.Version}}')
    $launcherText = [IO.File]::ReadAllText((Join-Path $script:ToolsDir 'DiscoveryLauncher.psm1'))
    Test-Case 'bounded: a call without a capture is unchanged: Invoke-DockerCli still returns ExitCode, Output, Error as text, and the original reading code (ReadToEndAsync of both streams, WaitForExit) is still the path without a capture' ($plain.ExitCode -eq 0 -and $plain.Output -ceq '29.0.0-test' -and $plain.Error -is [string] -and $launcherText.Contains('    $out = $p.StandardOutput.ReadToEndAsync(); $err = $p.StandardError.ReadToEndAsync()') -and $launcherText.Contains('    [pscustomobject]@{ ExitCode = $p.ExitCode; Output = $out.Result; Error = $err.Result }') -and $launcherText.Contains('if ($null -ne $Capture) { return (Invoke-BoundedProcess -FileName ''docker'''))
    # ---- F. retention of the resources of a Run whose stop is not confirmed (garbage collection in pwsh child processes; this process never
    # opens these guards or locks, so it cannot keep them alive by itself)
    $retDir = New-TempDir; $retScript = Join-Path $retDir 'retention-child.ps1'; [IO.File]::WriteAllText($retScript, $script:RetentionChild, $utf8)
    $libDir = Join-Path $PSScriptRoot 'lib'
    $readKv = { param($Out) $h = @{}; foreach ($ln in ($Out -split "`r?`n")) { if ($ln -match '^([a-z_0-9]+)=(.*)$') { $h[$Matches[1]] = $Matches[2] } }; $h }
    $uRoot = New-TestRepo; $cRoot = New-TestRepo
    $u = Invoke-ChildPwsh -ScriptPath $retScript -Arguments @('-Root', $uRoot, '-ControlRoot', $cRoot, '-Tools', $script:ToolsDir, '-Lib', $libDir, '-MutexName', (New-TestMutexName), '-Mode', 'unstopped') -TimeoutSec 300
    $k = & $readKv $u.Output
    Test-Case 'C2 retention: after Invoke-DiscoveryStart returns with the stop not confirmed, and after an explicit garbage collection with finalizers, the Run is retained (1 entry) and every input file still refuses a writer, the Run lock refuses another open, and the mutex is held (another thread cannot take it)' ($u.ExitCode -eq 0 -and $k['first_code'] -cne 'complete' -and $k['first_exit'] -cne '0' -and $k['retained'] -ceq 'True' -and $k['count'] -ceq '1' -and $k['files_held_after_gc'] -ceq 'True' -and $k['lock_held_after_gc'] -ceq 'True' -and $k['mutex_after_gc'] -ceq 'held') "exit=$($u.ExitCode) $($u.Output -replace "`r?`n", ' ') $($u.Error)"
    Test-Case 'C2 retention: the control is real: a guard that nothing references is closed by the garbage collector in the same child (its files become writable)' ($k['control_opened'] -ceq 'True' -and $k['control_released_by_gc'] -ceq 'True')
    Test-Case 'C2 retention: a later start in the same process is refused before any resource (run_lock, exit 2, no Run ID) and does not replace or release the earlier entry: after another collection it is still retained (1 entry) and everything is still held' ($k['second_code'] -ceq 'run_lock' -and $k['second_exit'] -ceq '2' -and $k['second_run_id_empty'] -ceq 'True' -and $k['retained_after_second'] -ceq 'True' -and $k['count_after_second'] -ceq '1' -and $k['files_held_after_second'] -ceq 'True' -and $k['lock_held_after_second'] -ceq 'True' -and $k['mutex_after_second'] -ceq 'held')
    Test-Case 'C2 retention: Import-Module -Force and Remove-Module of the Launcher do not release it (the store is a static .NET field): after a collection the entry, the file handles, the Run lock, and the mutex are still held' ($k['retained_after_reload'] -ceq 'True' -and $k['count_after_reload'] -ceq '1' -and $k['files_held_after_reload'] -ceq 'True' -and $k['lock_held_after_reload'] -ceq 'True' -and $k['mutex_after_reload'] -ceq 'held')
    $nRoot = New-TestRepo
    $n = Invoke-ChildPwsh -ScriptPath $retScript -Arguments @('-Root', $nRoot, '-ControlRoot', $cRoot, '-Tools', $script:ToolsDir, '-Lib', $libDir, '-MutexName', (New-TestMutexName), '-Mode', 'normal') -TimeoutSec 300
    $kn = & $readKv $n.Output
    Test-Case 'C2 retention: a normal end (complete, stop confirmed) retains nothing: after a collection the files are writable, the Run lock is free, and the mutex can be taken' ($n.ExitCode -eq 0 -and $kn['code'] -ceq 'complete' -and $kn['exit'] -ceq '0' -and $kn['retained'] -ceq 'False' -and $kn['count'] -ceq '0' -and $kn['files_free'] -ceq 'True' -and $kn['lock_held'] -ceq 'False' -and $kn['mutex'] -ceq 'acquired') "exit=$($n.ExitCode) $($n.Output -replace "`r?`n", ' ') $($n.Error)"
    $fRoot = New-TestRepo
    $f = Invoke-ChildPwsh -ScriptPath $retScript -Arguments @('-Root', $fRoot, '-ControlRoot', $cRoot, '-Tools', $script:ToolsDir, '-Lib', $libDir, '-MutexName', (New-TestMutexName), '-Mode', 'refused') -TimeoutSec 300
    $kf = & $readKv $f.Output
    Test-Case 'C2 retention: refusals before any resource (audit_config_missing, input_file_refused) retain nothing: no entry, the files writable, the Run lock and the mutex free' ($f.ExitCode -eq 0 -and $kf['code_a'] -ceq 'audit_config_missing' -and $kf['code_b'] -ceq 'input_file_refused' -and $kf['count'] -ceq '0' -and $kf['files_free'] -ceq 'True' -and $kf['lock_held'] -ceq 'False' -and $kf['mutex'] -ceq 'acquired') "exit=$($f.ExitCode) $($f.Output -replace "`r?`n", ' ') $($f.Error)"
    $lt = [IO.File]::ReadAllText((Join-Path $script:ToolsDir 'DiscoveryLauncher.psm1'))
    $storeSrc = [regex]::Match($lt, '(?s)public static class UnstoppedRunRetention.*?\n    \}').Value
    Test-Case 'C2 retention (static): the store is add-only (TryAdd; no TryRemove, Clear, indexer write, or release function), it is filled at exactly one place under "container exists and stop not confirmed", and no retained content is logged' ($storeSrc.Contains('Held.TryAdd(runId, resources)') -and -not ($storeSrc -match 'TryRemove|Clear\(|TryUpdate|Held\[') -and [regex]::Matches($lt, 'Save-UnstoppedRunResources -RunId').Count -eq 1 -and $lt.Contains('if ($null -ne $container -and -not $stopConfirmed -and $null -ne $runId) {') -and -not ($lt -match 'Remove-UnstoppedRun|Clear-UnstoppedRun|Release-UnstoppedRun') -and ((@((Get-Module DiscoveryLauncher).ExportedFunctions.Keys | Where-Object { $_ -like '*Unstopped*' } | Sort-Object)) -join ',') -ceq 'Get-UnstoppedRunRetainedCount,Test-UnstoppedRunRetained')
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