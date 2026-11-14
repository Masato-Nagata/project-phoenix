#Requires -Version 7.0
# Lease timing measurement tests (task 2.27) with the fake container CLI. No real daemon, no real container, no network. The
# simulated measurement containers are thread jobs that read the lease directory and write the acknowledgement directory, the way
# packages/verifier/src/leaseMeasure/harness.ts does. These tests check the tool; they are NOT a measurement, and the record they
# produce is never valid (too few samples), so they cannot unlock a Discovery Run.
. (Join-Path $PSScriptRoot 'lib/testlib.ps1')
. (Join-Path $PSScriptRoot 'lib/fakeDocker.ps1')
Import-Module (Join-Path $script:ToolsDir 'DiscoveryCommon.psm1') -Force -DisableNameChecking
Import-Module (Join-Path $script:ToolsDir 'LeaseTiming.psm1') -Force -DisableNameChecking
Import-Module (Join-Path $script:ToolsDir 'DiscoveryLauncher.psm1') -Force -DisableNameChecking
Import-Module (Join-Path $script:ToolsDir 'LeaseMeasure.psm1') -Force -DisableNameChecking

$detachFlag = '-' + 'd'
$quiet = { param($m) }
$settings = Get-LeaseSettings   # the project settings; a pwsh writer needs about a second to start, so a smaller S would be flaky

# The simulated measurement container (one thread job per container).
$containerBody = {
    param($Mode, $LeaseDir, $AckDir, $Container, [long]$S)
    $hb = Join-Path $LeaseDir 'heartbeat'
    $read = { try { [long]([IO.File]::ReadAllText($hb).Trim()) } catch { [long]-1 } }
    $put = { param($name, $text) $tmp = Join-Path $AckDir ".$name.tmp"; [IO.File]::WriteAllText($tmp, $text); [IO.File]::Move($tmp, (Join-Path $AckDir $name), $true) }
    $sw = [Diagnostics.Stopwatch]::StartNew()
    try {
        switch ($Mode) {
            'propagate' {
                $last = [long]-1; $lastT = $null; $gaps = [System.Collections.Generic.List[long]]::new()
                while (-not (Test-Path -LiteralPath (Join-Path $LeaseDir 'revoked')) -and $sw.ElapsedMilliseconds -lt 120000) {
                    $v = & $read
                    if ($v -gt $last) {
                        & $put "beat-$v" ''
                        if ($null -ne $lastT) { $gaps.Add($sw.ElapsedMilliseconds - $lastT) }
                        $lastT = $sw.ElapsedMilliseconds; $last = $v
                    }
                    Start-Sleep -Milliseconds 2
                }
                & $put 'observer.json' ('{"gaps":[' + ($gaps -join ',') + ']}')
            }
            'startup' {
                $v0 = & $read; $result = 'refused'
                while ($sw.ElapsedMilliseconds -lt $S) { if ((& $read) -gt $v0) { $result = 'passed'; break }; Start-Sleep -Milliseconds 10 }
                & $put 'startup.json' ('{"requests":0,"result":"' + $result + '"}')
            }
            'kill' {
                $v0 = & $read
                while ($sw.ElapsedMilliseconds -lt $S -and (& $read) -le $v0) { Start-Sleep -Milliseconds 10 }
                if ((& $read) -le $v0) { return }
                & $put 'proof-passed' ''
                $last = & $read; $changed = $sw.ElapsedMilliseconds
                while ($sw.ElapsedMilliseconds - $changed -lt $S -and $sw.ElapsedMilliseconds -lt 120000) {
                    $v = & $read; if ($v -gt $last) { $last = $v; $changed = $sw.ElapsedMilliseconds }
                    Start-Sleep -Milliseconds 10
                }
            }
        }
    } finally { $Container.Running = $false }
}

function Install-MeasureFake {
    param([string]$Root)
    $fake = New-FakeDocker -Root $Root
    $fake.State.Jobs = [System.Collections.ArrayList]::Synchronized([System.Collections.ArrayList]::new())
    $fake.State.Detached = [System.Collections.ArrayList]::Synchronized([System.Collections.ArrayList]::new())
    $body = $containerBody
    $fake.State.OnRunDetached = {
        param($Arguments, $s)
        $get = { param($n) $i = [Array]::IndexOf($Arguments, $n); $Arguments[$i + 1] }
        $name = & $get '--name'
        $envs = @{}; $mounts = @{}
        for ($i = 0; $i -lt $Arguments.Count - 1; $i++) {
            if ($Arguments[$i] -eq '--env') { $kv = $Arguments[$i + 1].Split('=', 2); $envs[$kv[0]] = $kv[1] }
            if ($Arguments[$i] -eq '--mount') { $m = @{}; foreach ($p in $Arguments[$i + 1].Split(',')) { $kv = $p.Split('=', 2); $m[$kv[0]] = $(if ($kv.Count -gt 1) { $kv[1] } else { $true }) }; $mounts[$m['target']] = $m }
        }
        $c = [hashtable]::Synchronized(@{ Running = $true; ExitCode = '0'; Labels = @{}; Mounts = @(); Networks = @('none'); Polls = $null })
        $s.Containers[$name] = $c
        [void]$s.Detached.Add([pscustomobject]@{ Name = $name; Arguments = $Arguments; Env = $envs; Mounts = $mounts })
        $job = Start-ThreadJob -ScriptBlock $body -ArgumentList $envs['PHOENIX_MEASURE_MODE'], $mounts['/run/lease']['source'], $mounts['/run/ack']['source'], $c, ([long]$envs['PHOENIX_LEASE_S_MS'])
        [void]$s.Jobs.Add($job)
        [pscustomobject]@{ ExitCode = 0; Output = "id-$name"; Error = '' }
    }.GetNewClosure()
    Set-DockerCliInvoker -Invoker $fake.Invoker
    $fake
}

function Get-FilesUnder { param([string]$Root) @(Get-ChildItem -LiteralPath $Root -Recurse -File -Force | ForEach-Object { [IO.Path]::GetRelativePath($Root, $_.FullName).Replace('\', '/') } | Sort-Object) }

Invoke-TestMain {
    Write-Host '=== Lease timing measurement (task 2.27, mock only; no real measurement) ===' -ForegroundColor Cyan
    $writer = Join-Path $script:ToolsDir 'LeaseWriter.ps1'

    # ---------------------------------------------------------------- static checks
    $src = [IO.File]::ReadAllText((Join-Path $script:ToolsDir 'LeaseMeasure.psm1'))
    Test-Case 'static: the measurement never takes the conformance mutex (Run lock only)' (-not $src.Contains('Enter-DiscoveryLocks') -and -not $src.Contains('Threading.Mutex') -and $src.Contains('Enter-RunLock'))
    Test-Case 'static: the measurement never names the lab network, the override, the Legacy_App, or the Approval_Store' (-not ($src -match 'phoenix-discovery-lab|docker-compose|legacy-app|reverse-proxy|Invoke-ApprovalStoreRequest|approvals\.jsonl'))
    $entrySrc = [IO.File]::ReadAllText((Join-Path $script:ToolsDir 'Measure-LeaseTiming.ps1'))
    Test-Case 'static: the entry point declares no parameter and uses the design minimums (300 beats, 10 healthy, 5 stopped, 10 kills)' ($entrySrc.Contains('param()') -and $entrySrc.Contains('-Beats 300 -HealthyTrials 10 -StoppedTrials 5 -KillTrials 10'))

    # Regression (2026-11-13: the entry script failed with "Get-LeaseSettings is not recognized"). In a FRESH pwsh process, run exactly
    # the Import-Module statements of the entry script (taken from its syntax tree, with $PSScriptRoot replaced by the tools directory), then
    # resolve every command the script calls. Nothing else of the script runs: no Docker call, no lock, no file, no container.
    $probeDir = New-TempDir
    $probe = Join-Path $probeDir 'resolve-entry-commands.ps1'
    [IO.File]::WriteAllText($probe, @"
param([string]`$Entry, [string]`$Tools)
`$ErrorActionPreference = 'Stop'
`$ast = [System.Management.Automation.Language.Parser]::ParseFile(`$Entry, [ref]`$null, [ref]`$null)
`$cmds = @(`$ast.FindAll({ param(`$n) `$n -is [System.Management.Automation.Language.CommandAst] }, `$true))
`$imports = @(`$cmds | Where-Object { `$_.GetCommandName() -eq 'Import-Module' })
`$lit = "'" + `$Tools.Replace("'", "''") + "'"
foreach (`$i in `$imports) { Invoke-Expression (`$i.Extent.Text.Replace('`$PSScriptRoot', `$lit)) }
`$names = @(`$cmds | ForEach-Object { `$_.GetCommandName() } | Where-Object { `$_ } | Sort-Object -Unique)
`$missing = @(`$names | Where-Object { -not (Get-Command -Name `$_ -ErrorAction SilentlyContinue) })
`$s = Get-LeaseSettings
'imports=' + `$imports.Count
'names=' + (`$names -join ',')
'missing=' + (`$missing -join ',')
'settings=' + `$s.heartbeatIntervalMs + '/' + `$s.staleAfterMs
"@, [Text.UTF8Encoding]::new($false))
    $snapshot = { @('discovery/config', 'discovery/locks', 'discovery/leases') | ForEach-Object { $d = Join-Path $script:RepoRoot $_; if (Test-Path -LiteralPath $d) { @(Get-ChildItem -LiteralPath $d -Recurse -Force | ForEach-Object { $_.FullName + '|' + $_.LastWriteTimeUtc.Ticks }) } else { "$_|absent" } } }
    $before = (& $snapshot) -join "`n"
    $res = Invoke-ChildPwsh -ScriptPath $probe -Arguments @('-Entry', (Join-Path $script:ToolsDir 'Measure-LeaseTiming.ps1'), '-Tools', $script:ToolsDir) -TimeoutSec 120
    $lines = @($res.Output -split "`r?`n")
    $val = { param($k) ($lines | Where-Object { $_ -like "$k=*" } | Select-Object -First 1) -replace "^$k=", '' }
    $names = (& $val 'names') -split ','
    Test-Case 'entry resolution: in a fresh process, the Import-Module statements of the entry script make every command it calls resolvable (Get-LeaseSettings and Invoke-LeaseTimingMeasurement included)' ($res.ExitCode -eq 0 -and [int](& $val 'imports') -ge 2 -and ($names -contains 'Get-LeaseSettings') -and ($names -contains 'Invoke-LeaseTimingMeasurement') -and (& $val 'missing') -eq '') "exit=$($res.ExitCode) out=$($res.Output.Trim()) err=$($res.Error.Trim())"
    Test-Case 'entry resolution: Get-LeaseSettings resolved through the entry imports returns the project settings H 1000 / S 4000' ((& $val 'settings') -eq '1000/4000') (& $val 'settings')
    Test-Case 'entry resolution: the check changed no measurement file, lock, or lease directory' (((& $snapshot) -join "`n") -ceq $before)
    $args1 = New-MeasureContainerArgs -Name 'n1' -Mode 'kill' -RepoRoot 'C:\repo' -LeaseDir 'C:\repo\discovery\leases\measure-x' -AckDir 'C:\repo\discovery\leases\measure-x-ack' -MeasureRunId 'measure-x' -Nonce 'abc' -Settings $settings
    $j = $args1 -join ' '
    Test-Case 'container args: detached, --network none, read-only, no capability, no new privileges, non-root, the lease-measure label' ($args1[0] -eq 'run' -and $args1[1] -eq $detachFlag -and $j.Contains('--network none') -and $j.Contains('--read-only') -and $j.Contains('--cap-drop ALL') -and $j.Contains('no-new-privileges:true') -and $j.Contains('--user 10001:10001') -and $j.Contains('phoenix.discovery.role=lease-measure'))
    Test-Case 'container args: the lease is read-only, the acknowledgement directory is the only writable mount, no port is published' ($j.Contains('target=/run/lease,readonly') -and $j.Contains('target=/run/ack ') -and @($args1 | Where-Object { $_ -like 'type=*' -and $_ -notlike '*readonly*' }).Count -eq 1 -and -not ($args1 -contains '-p') -and -not ($args1 -contains '--publish'))
    Test-Case 'container args: the toolchain image and the measurement entry of the verifier' ($j.Contains('phoenix/discovery-toolchain:m0 node /workspace/packages/verifier/dist/leaseMeasure/main.js'))

    # ---------------------------------------------------------------- invalid settings: refused before any side effect
    $root0 = New-TempDir
    $fake0 = Install-MeasureFake -Root $root0
    $r0 = Invoke-LeaseTimingMeasurement -RepoRoot $root0 -LockPath (Join-Path $root0 'discovery/locks/discovery-run.lock') -Settings ([ordered]@{ heartbeatIntervalMs = 1000; staleAfterMs = 2000 }) -Beats 1 -HealthyTrials 1 -StoppedTrials 1 -KillTrials 1 -WriterScript $writer -Log $quiet
    Test-Case 'invalid settings (S < 3 H): exit 2, lease_timing_invalid, no Docker call, no file' ($r0.ExitCode -eq 2 -and $r0.Code -eq 'lease_timing_invalid' -and $fake0.State.Calls.Count -eq 0 -and (Get-FilesUnder $root0).Count -eq 0)

    # ---------------------------------------------------------------- Run lock held: refused
    $root1 = New-TempDir
    $fake1 = Install-MeasureFake -Root $root1
    $lockPath1 = Join-Path $root1 'discovery/locks/discovery-run.lock'
    $held = Enter-RunLock -LockPath $lockPath1
    $r1 = Invoke-LeaseTimingMeasurement -RepoRoot $root1 -LockPath $lockPath1 -Settings $settings -Beats 1 -HealthyTrials 1 -StoppedTrials 1 -KillTrials 1 -WriterScript $writer -Log $quiet
    $held.Dispose()
    Test-Case 'Run lock held (a Run is active): exit 2, run_lock, no Docker call' ($r1.ExitCode -eq 2 -and $r1.Code -eq 'run_lock' -and $fake1.State.Calls.Count -eq 0)

    # ---------------------------------------------------------------- a short mock measurement
    $root = New-TempDir
    $fake = Install-MeasureFake -Root $root
    $lockPath = Join-Path $root 'discovery/locks/discovery-run.lock'
    $recordPath = Join-Path $root 'discovery/config/lease-timing.json'
    $r = Invoke-LeaseTimingMeasurement -RepoRoot $root -LockPath $lockPath -Settings $settings -Beats 5 -HealthyTrials 2 -StoppedTrials 1 -KillTrials 2 -WriterScript $writer -RecordPath $recordPath -Log $quiet
    $fake.State.Jobs | Wait-Job -Timeout 60 | Out-Null
    $fake.State.Jobs | Remove-Job -Force
    $rec = if (Test-Path -LiteralPath $recordPath) { ConvertFrom-JsonStrict -Text ([IO.File]::ReadAllText($recordPath)) } else { $null }

    Test-Case 'mock: the record is written but NOT valid (too few samples): exit 1, lease_timing_unmeasured; a mock can never unlock a Run' ($r.ExitCode -eq 1 -and $r.Code -eq 'lease_timing_unmeasured' -and ($r.Problems -contains 'too_few_beats')) "exit=$($r.ExitCode) code=$($r.Code) problems=$($r.Problems -join ',')"
    Test-Case 'mock: the record has the kind, the settings hash, the Docker facts, the image digest, and the fixed statement' ($null -ne $rec -and $rec['kind'] -ceq 'lease-timing-measurement' -and $rec['settingsSha256'] -ceq (Get-LeaseSettingsSha256 -Settings $settings) -and $rec['docker']['serverVersion'] -ceq '29.0.0-test' -and $rec['probeImageDigest'] -ceq ('sha256:' + ('1' * 64)) -and $rec['statement'] -ceq (Get-LeaseTimingStatement))
    Test-Case 'mock: one round trip per beat, and the gaps of the observer are taken' ($null -ne $rec -and $rec['propagation']['beats'] -eq 5 -and @($rec['propagation']['roundTripsMs']).Count -eq 5 -and $rec['propagation']['maxGapMs'] -gt 0)
    Test-Case 'mock: healthy writers pass, the stopped writer is refused with zero requests' ($null -ne $rec -and $rec['startup']['healthyPassed'] -eq 2 -and $rec['startup']['stoppedRefused'] -eq 1 -and $rec['startup']['stoppedRequests'] -eq 0) ($(if ($rec) { ConvertTo-CanonicalJson -Value $rec['startup'] }))
    $ks = if ($rec) { @($rec['kill']['samplesMs']) } else { @() }
    Test-Case 'mock: one kill sample per trial, each at least S - H after the kill (the writer was really killed)' ($ks.Count -eq 2 -and @($ks | Where-Object { $_ -lt ($settings.staleAfterMs - $settings.heartbeatIntervalMs) }).Count -eq 0) ($ks -join ',')

    $detached = @($fake.State.Detached)
    Test-Case 'mock: every container was started with --network none and the lease-measure label (1 propagation, 3 start-up, and 2 kill containers)' ($detached.Count -eq 6 -and @($detached | Where-Object { -not (($_.Arguments -join ' ').Contains('--network none')) -or -not (($_.Arguments -join ' ').Contains('phoenix.discovery.role=lease-measure')) }).Count -eq 0) "count=$($detached.Count)"
    Test-Case 'mock: every container was removed at the end' (@($fake.State.Calls | Where-Object { $_ -like 'rm --force *' }).Count -eq 6 -and $fake.State.Containers.Count -eq 0)
    $calls = @($fake.State.Calls)
    Test-Case 'mock: no volume, no network, no create/start of a runtime container, no Compose' (@($calls | Where-Object { $_ -like 'volume *' -or $_ -like 'network *' -or $_ -like 'create *' -or $_ -like 'start *' -or $_ -like 'compose*' }).Count -eq 0)

    $files = Get-FilesUnder (Join-Path $root 'discovery')
    $outside = @($files | Where-Object { $_ -ne 'config/lease-timing.json' -and $_ -ne 'locks/discovery-run.lock' -and $_ -notmatch '^leases/measure-[0-9]{8}T[0-9]{6}Z-[0-9a-f]{8}((-ack)?/|-heartbeat\.json$|-writer\.log$)' })
    Test-Case 'mock: it writes only the record, the lock file, and its own measure directories (no Run, no approval, no lease of a Run)' ($outside.Count -eq 0 -and -not (Test-Path -LiteralPath (Join-Path $root 'discovery/runs')) -and -not (Test-Path -LiteralPath (Join-Path $root 'discovery/approvals'))) ($outside -join ',')
    # heartbeat write diagnostics (instrumentation only; not in the record, used by no rule)
    $diagFile = @(Get-ChildItem -LiteralPath (Join-Path $root 'discovery/leases') -Filter 'measure-*-heartbeat.json' -File)
    $diag = if ($diagFile.Count -eq 1) { ConvertFrom-JsonStrict -Text ([IO.File]::ReadAllText($diagFile[0].FullName)) } else { $null }
    Test-Case 'diagnostics: one heartbeat file with one entry per propagation beat (value, lateness, write time, attempts, gap) and the maxima' ($null -ne $diag -and $diag['beats'] -eq 5 -and @($diag['perBeat']).Count -eq 5 -and @($diag['perBeat'] | ForEach-Object { $_['value'] }) -join ',' -eq '2,3,4,5,6' -and $diag['maxWriteMs'] -ge 0 -and $diag['jitterMs'] -eq 250 -and $diag['replace']['budgetMs'] -eq 250) "files=$($diagFile.Count)"
    $wlog = @(Get-ChildItem -LiteralPath (Join-Path $root 'discovery/leases') -Filter 'measure-*-writer.log' -File)
    $wl = if ($wlog.Count -eq 1) { @([IO.File]::ReadAllLines($wlog[0].FullName) | Where-Object { $_ }) } else { @() }
    Test-Case 'diagnostics: the writer processes log every renewal as pid,value,lateness,write time,attempts' ($wl.Count -gt 0 -and @($wl | Where-Object { $_ -notmatch '^[0-9]+,[0-9]+,[0-9]+,[0-9]+,[0-9]+$' }).Count -eq 0) "lines=$($wl.Count)"
    Test-Case 'diagnostics: the lease-timing record keeps exactly its fields (the instrumentation adds nothing to it)' ($null -ne $rec -and ((@($rec.Keys) | Sort-Object) -join ',') -ceq 'docker,kill,kind,leaseMount,measuredAt,probeImageDigest,propagation,schemaVersion,settings,settingsSha256,startup,statement')
    $again = Enter-RunLock -LockPath $lockPath
    Test-Case 'mock: the Run lock is released at the end' ($null -ne $again); if ($again) { $again.Dispose() }
}