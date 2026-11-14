#Requires -Version 7.0
# Unit tests of the Discovery_Override isolation test (test_discovery_network_isolation.ps1, lib/labIsolation.psm1) with a FAKE
# Docker CLI. No real daemon, no network, no container, no override. Temporary record and baseline paths only.
. (Join-Path $PSScriptRoot 'lib/testlib.ps1')
Import-Module (Join-Path $script:ToolsDir 'DiscoveryCommon.psm1') -Force -DisableNameChecking
Import-Module (Join-Path $script:ToolsDir 'DiscoveryLauncher.psm1') -Force -DisableNameChecking
Import-Module (Join-Path $PSScriptRoot 'lib/labIsolation.psm1') -Force -DisableNameChecking
$quiet = { param($m) }
$noSleep = { param($ms) }
$lab = 'phoenix-discovery-lab'

function New-Svc {
    param([string]$Name, [hashtable]$Nets, $Ports = @{}, [bool]$Running = $true)
    @{ Name = "/$Name"; Created = '2026-11-13T00:00:00.0000000Z'; State = @{ Running = $Running }; Config = @{ User = '' }
       HostConfig = @{ PortBindings = $Ports; NetworkMode = 'x' }; Mounts = @(); NetworkSettings = @{ Networks = $Nets } }
}

# The fake: state of the applied environment and a responder for the probe plans.
function New-FakeLab {
    param([switch]$NotApplied)
    $s = [hashtable]::Synchronized(@{ Calls = [System.Collections.ArrayList]::new(); Probes = @{}; Tcp = @{}; Dns = @{}; Http = @{}; Scan = $null; CtlTcp = @{}; ProbeMutate = $null; ExtraMembers = @() })
    $s.Net = if ($NotApplied) { $null } else { @{ Name = $lab; Driver = 'bridge'; Internal = $true; EnableIPv6 = $false; Labels = @{ 'phoenix.discovery.network' = 'discovery-lab' }; IPAM = @{ Config = @(@{ Subnet = '172.30.0.0/16'; Gateway = '172.30.0.1' }) } } }
    $proxyNets = @{ 'project-phoenix_legacy-internal' = @{ IPAddress = '172.20.0.4' }; 'project-phoenix_legacy-api' = @{ IPAddress = '172.21.0.2' } }
    if (-not $NotApplied) { $proxyNets[$lab] = @{ IPAddress = '172.30.0.2' } }
    $s.Svc = @{
        'reverse-proxy' = New-Svc 'project-phoenix-reverse-proxy-1' $proxyNets @{ '8080/tcp' = @(@{ HostIp = '127.0.0.1'; HostPort = '8056' }) }
        'legacy-app' = New-Svc 'project-phoenix-legacy-app-1' @{ 'project-phoenix_legacy-internal' = @{ IPAddress = '172.20.0.3' } }
        'legacy-db' = New-Svc 'project-phoenix-legacy-db-1' @{ 'project-phoenix_legacy-internal' = @{ IPAddress = '172.20.0.2' } }
    }
    $invoker = {
        param([string[]]$Arguments)
        $st = $s
        [void]$st.Calls.Add(($Arguments -join ' '))
        $ok = { param($o = '') [pscustomobject]@{ ExitCode = 0; Output = [string]$o; Error = '' } }
        $no = { [pscustomobject]@{ ExitCode = 1; Output = ''; Error = 'Error: No such object' } }
        $after = { param($n) $i = [Array]::IndexOf($Arguments, $n); if ($i -ge 0) { $Arguments[$i + 1] } else { $null } }
        $j = { param($o) ConvertTo-Json -InputObject $o -Depth 20 -Compress }
        switch ($Arguments[0]) {
            'version' { return (& $ok '29.9.2') }
            'image' { return (& $ok ('sha256:' + ('e' * 64))) }
            'network' {
                if ($Arguments[1] -eq 'inspect' -and $Arguments[2] -eq $lab -and $null -ne $st.Net) {
                    $members = @{ 'p1' = @{ Name = 'project-phoenix-reverse-proxy-1' } }
                    $i = 0; foreach ($n in $st.Probes.Keys) { $p = $st.Probes[$n]; if ($p.Running -and $p.Network -eq $lab) { $i++; $members["probe$i"] = @{ Name = $n } } }
                    foreach ($x in $st.ExtraMembers) { $members[$x] = @{ Name = $x } }
                    $n2 = $st.Net.Clone(); $n2['Containers'] = $members
                    return (& $ok (& $j $n2))
                }
                return (& $no)
            }
            'ps' {
                $f = @(); for ($i = 0; $i -lt $Arguments.Count - 1; $i++) { if ($Arguments[$i] -eq '--filter') { $f += $Arguments[$i + 1] } }
                $svc = @($f | Where-Object { $_ -like 'label=com.docker.compose.service=*' }) | ForEach-Object { $_.Split('=')[-1] }
                if ($svc) { if ($st.Svc.ContainsKey($svc)) { return (& $ok "id-$svc") } else { return (& $ok '') } }
                if ($f -contains 'label=phoenix.discovery.role=isolation-probe') { return (& $ok (($st.Probes.Keys) -join "`n")) }
                return (& $ok '')
            }
            'inspect' {
                $target = $Arguments[1]
                if ($Arguments[1] -eq '--format' -and $Arguments[2] -eq '{{.State.Running}}') { $n = $Arguments[3]; if ($st.Probes.ContainsKey($n)) { $st.Probes[$n].Running = $false; return (& $ok 'false') }; return (& $no) }
                if ($target -like 'id-*') { return (& $ok (& $j $st.Svc[$target.Substring(3)])) }
                if ($st.Probes.ContainsKey($target)) { return (& $ok (& $j $st.Probes[$target].Json)) }
                return (& $no)
            }
            'create' {
                $name = & $after '--name'; $netw = & $after '--network'
                $envs = @{}; for ($i = 0; $i -lt $Arguments.Count - 1; $i++) { if ($Arguments[$i] -eq '--env') { $kv = $Arguments[$i + 1].Split('=', 2); $envs[$kv[0]] = $kv[1] } }
                $mounts = @(); for ($i = 0; $i -lt $Arguments.Count - 1; $i++) { if ($Arguments[$i] -eq '--mount') { $m = @{}; foreach ($p in $Arguments[$i + 1].Split(',')) { $kv = $p.Split('=', 2); $m[$kv[0]] = $(if ($kv.Count -gt 1) { $kv[1] } else { $true }) }; $mounts += @{ Type = $m['type']; Source = $m['source']; Destination = $m['target']; RW = -not $m.ContainsKey('readonly') } } }
                $json = @{ Name = "/$name"; Config = @{ User = (& $after '--user') }; Mounts = $mounts; NetworkSettings = @{ Networks = @{ $netw = @{} } }
                    HostConfig = @{ NetworkMode = $netw; Privileged = $false; CapDrop = @(& $after '--cap-drop'); CapAdd = $null; PortBindings = @{}; PublishAllPorts = $false
                        Memory = $(if (& $after '--memory') { 268435456 } else { 0 }); NanoCpus = $(if (& $after '--cpus') { 500000000 } else { 0 }); PidsLimit = [long](& $after '--pids-limit')
                        ReadonlyRootfs = ($Arguments -contains '--read-only'); SecurityOpt = @(& $after '--security-opt') } }
                if ($null -ne $st.ProbeMutate -and $netw -eq $lab) { & $st.ProbeMutate $json }
                $st.Probes[$name] = @{ Json = $json; Network = $netw; Plan = (ConvertFrom-Json -InputObject $envs['PHOENIX_PROBE_PLAN'] -AsHashtable -Depth 16); Running = $false }
                return (& $ok "id-$name")
            }
            'start' { $p = $st.Probes[$Arguments[1]]; if ($null -eq $p) { return (& $no) }; $p.Running = $true; return (& $ok $Arguments[1]) }
            'logs' {
                $p = $st.Probes[$Arguments[1]]; if ($null -eq $p) { return (& $no) }
                $plan = $p.Plan
                $res = @{ tcp = @{}; dns = @{}; http = @{}; scan = $null }
                foreach ($t in @($plan['tcp'])) {
                    $id = $t['id']
                    $d = if ($id -like 'ctl-*') { 'connected' } elseif ($id -eq 'proxy-8080-name' -or $id -eq 'ext-ctl') { 'connected' } elseif ($id -eq 'proxy-9-closed-control') { 'closed' } elseif ($id -in 'app-name', 'db-name' -or $id -like 'hostname-gw-*') { 'dns_unresolved' } elseif ($id -like 'gw-*') { 'unreachable' } else { 'blocked' }
                    if ($id -like 'ctl-*' -and $st.CtlTcp.ContainsKey($id)) { $d = $st.CtlTcp[$id] }
                    if ($st.Tcp.ContainsKey($id)) { $d = $st.Tcp[$id] }
                    $res.tcp[$id] = $d
                }
                foreach ($q in @($plan['dns'])) { $id = $q['id']; $res.dns[$id] = $(if ($st.Dns.ContainsKey($id)) { $st.Dns[$id] } elseif ($id -eq 'dns-proxy') { @{ result = 'resolved'; addresses = @('172.30.0.2') } } else { @{ result = 'dns_unresolved'; addresses = @() } }) }
                foreach ($h in @($plan['http'])) {
                    $id = $h['id']
                    $d = if ($id -eq 'health') { @{ result = 'response'; status = 200; appJson = $true; dbOk = $true; nginxDefault = $false } } elseif ($id -eq 'fwd-connect') { @{ result = 'response'; status = 400; appJson = $false; nginxDefault = $false } } else { @{ result = 'response'; status = 404; appJson = $true; nginxDefault = $false } }
                    if ($st.Http.ContainsKey($id)) { $d = $st.Http[$id] }
                    $res.http[$id] = $d
                }
                if ($plan['scan']) { $res.scan = $(if ($null -ne $st.Scan) { $st.Scan } else { @{ host = 'reverse-proxy'; scanned = @($plan['scan']['ports']).Count; open = @(8080); counts = @{} } }) }
                return (& $ok ('PROBE-RESULT ' + (& $j $res)))
            }
            'rm' { $n = $Arguments[-1]; [void]$st.Probes.Remove($n); return (& $ok $n) }
        }
        & $ok ''
    }.GetNewClosure()
    Set-DockerCliInvoker -Invoker $invoker
    $s
}

function Write-Baseline {
    param([string]$Path, [string]$ComposeSha = (Get-Sha256HexOfFile -Path (Join-Path $script:RepoRoot 'infra/docker-compose.yml')))
    $b = [ordered]@{ composeSha256 = $ComposeSha; kind = 'lab-isolation-baseline'; overrideSha256 = 'x'; schemaVersion = 1
        services = [ordered]@{
            'legacy-app' = [ordered]@{ networks = @('project-phoenix_legacy-internal'); ports = '{}' }
            'legacy-db' = [ordered]@{ networks = @('project-phoenix_legacy-internal'); ports = '{}' }
            'reverse-proxy' = [ordered]@{ networks = @('project-phoenix_legacy-api', 'project-phoenix_legacy-internal'); ports = '{"8080/tcp":[{"HostIp":"127.0.0.1","HostPort":"8056"}]}' } } }
    [IO.File]::WriteAllText($Path, (ConvertTo-Json -InputObject $b -Depth 8))
}

function Invoke-Applied {
    param([scriptblock]$Setup, [string]$ComposeSha)
    $d = New-TempDir
    $fake = New-FakeLab
    if ($Setup) { & $Setup $fake }
    $bp = Join-Path $d 'baseline.json'; if ($ComposeSha) { Write-Baseline -Path $bp -ComposeSha $ComposeSha } else { Write-Baseline -Path $bp }
    $r = Invoke-LabIsolation -Mode Applied -RepoRoot $script:RepoRoot -BaselinePath $bp -RecordPath (Join-Path $d 'record.json') -Log $quiet -Sleep $noSleep
    $byId = @{}; foreach ($x in $r.Checks) { $byId[$x['id']] = $x }
    [pscustomobject]@{ R = $r; Fake = $fake; Dir = $d; ById = $byId }
}

Invoke-TestMain {
    Write-Host '=== Discovery_Override isolation test: unit tests with a fake Docker CLI ===' -ForegroundColor Cyan
    $modSrc = [IO.File]::ReadAllText((Join-Path $PSScriptRoot 'lib/labIsolation.psm1')); $entrySrc = [IO.File]::ReadAllText((Join-Path $PSScriptRoot 'test_discovery_network_isolation.ps1'))
    $all = $modSrc + $entrySrc
    Test-Case 'static: no compose, no network create/rm/connect/disconnect, no exec/stop/restart/kill/pull of any container, no volume command' (-not ($all -cmatch "'compose'|'network',\s*'(create|rm|remove|connect|disconnect|prune)'|'(exec|stop|restart|kill|pull|volume|up|down)'") -and $modSrc.Contains("'--pull', 'never'"))
    Test-Case 'static: every Docker call goes through Invoke-DockerCli (no direct docker process)' (-not ($all -match "(^|\s)&\s*docker|Start-Process\s+docker|ProcessStartInfo\]::new\('docker"))
    $legacy = Join-Path $script:RepoRoot 'tests/legacy-sample/test_network_isolation.ps1'
    $headBlob = (git -C $script:RepoRoot ls-tree HEAD -- tests/legacy-sample/test_network_isolation.ps1) -replace '^\S+\s+\S+\s+(\S+)\s.*$', '$1'
    $workBlob = (git -C $script:RepoRoot hash-object -- $legacy)
    Test-Case 'static: tests/legacy-sample/test_network_isolation.ps1 is unchanged (same Git blob as HEAD)' ($headBlob -and $headBlob -ceq $workBlob) "head=$headBlob work=$workBlob"

    # ---------------------------------------------------------------- pure checks and the record format
    $fv = Get-RuntimeRightsViolations -C (Get-NonCompliantFixture) -Network $lab -AllowedMountTargets @('/probe')
    Test-Case 'D negative fixture: the rights check reports every non-compliant property' (@(Get-NonCompliantExpected | Where-Object { $fv -notcontains $_ }).Count -eq 0) ($fv -join ',')
    $good = @{ Config = @{ User = '10001:10001' }; Mounts = @(@{ Source = 'C:\x'; Destination = '/probe'; RW = $false }); NetworkSettings = @{ Networks = @{ $lab = @{} } }
        HostConfig = @{ NetworkMode = $lab; Privileged = $false; CapDrop = @('ALL'); CapAdd = $null; PortBindings = @{}; PublishAllPorts = $false; Memory = 1; NanoCpus = 1; PidsLimit = 1; ReadonlyRootfs = $true; SecurityOpt = @('no-new-privileges:true') } }
    Test-Case 'D compliant definition: no violation' ((Get-RuntimeRightsViolations -C $good -Network $lab -AllowedMountTargets @('/probe')).Count -eq 0)
    $dAll = Test-RuntimeRights -ProbeJson $good -Fixture $good -FixtureExpected @('user', 'docker_socket')
    $blind = @($dAll | Where-Object { $_['id'] -eq 'D-C1' })
    Test-Case 'D control: a fixture that the check does not report as non-compliant makes the control FAIL (a blind check is visible)' ($blind.Count -eq 1 -and $blind[0]['status'] -eq 'FAIL' -and (@($blind[0]['observed']['notReported']) -join ',') -ceq 'user,docker_socket')
    $m = Compare-Members -Actual @('a', 'b') -Expected @('a')
    Test-Case 'A member comparison reports an extra member and a missing one' (-not $m.Equal -and ($m.Extra -contains 'b') -and -not (Compare-Members -Actual @('a') -Expected @('a', 'c')).Equal)
    $nm = Get-NotMeasuredChecks
    Test-Case 'F: every unmeasured path is written NOT MEASURED and never assumed blocked' (@($nm).Count -eq 7 -and @($nm | Where-Object { $_['status'] -cne 'NOT MEASURED' -or $_['observed']['assumedBlocked'] -ne $false }).Count -eq 0)
    $recBad = @{ checks = @(@($nm)[0..5]) + @(@{ group = 'F'; id = 'F-proxy-outbound'; name = 'x'; status = 'PASS'; control = $false }) + @(@{ group = 'B'; id = 'B1'; name = 'x'; status = 'NOT MEASURED'; control = $false }) }
    $bad = Test-IsolationRecord -Record $recBad
    Test-Case 'record format: rejects a "blocked" (PASS) status for an unmeasured path and NOT MEASURED for a measured reachability check' (($bad -contains 'F_not_measured_only:F-proxy-outbound') -and ($bad -contains 'B_measured_only:B1'))
    Test-Case 'record format: rejects a record without every NOT MEASURED path' ((Test-IsolationRecord -Record @{ checks = @() }).Count -eq 7)

    # ---------------------------------------------------------------- not applied (the state before 2.19)
    $d0 = New-TempDir; $f0 = New-FakeLab -NotApplied
    $r0 = Invoke-LabIsolation -Mode Applied -RepoRoot $script:RepoRoot -BaselinePath (Join-Path $d0 'b.json') -RecordPath (Join-Path $d0 'r.json') -Log $quiet -Sleep $noSleep
    Test-Case 'not applied: Applied mode exits 3 (not_applied), creates no container, writes no record' ($r0.ExitCode -eq 3 -and $r0.Code -eq 'not_applied' -and @($f0.Calls | Where-Object { $_ -like 'create *' -or $_ -like 'start *' }).Count -eq 0 -and -not (Test-Path (Join-Path $d0 'r.json')))
    $rb = Invoke-LabIsolation -Mode Baseline -RepoRoot $script:RepoRoot -BaselinePath (Join-Path $d0 'b.json') -Log $quiet -Sleep $noSleep
    $bj = ConvertFrom-JsonStrict -Text ([IO.File]::ReadAllText((Join-Path $d0 'b.json')))
    Test-Case 'baseline (not applied): written with the two proxy networks, the ports, and both hashes; read-only calls only' ($rb.ExitCode -eq 0 -and (@($bj['services']['reverse-proxy']['networks']) -join ',') -ceq 'project-phoenix_legacy-api,project-phoenix_legacy-internal' -and $bj['composeSha256'] -match '^[0-9a-f]{64}$' -and @($f0.Calls | Where-Object { $_ -notmatch '^(version|network inspect|ps |inspect )' }).Count -eq 0)
    $f1 = New-FakeLab
    $rb2 = Invoke-LabIsolation -Mode Baseline -RepoRoot $script:RepoRoot -BaselinePath (Join-Path $d0 'b2.json') -Log $quiet -Sleep $noSleep
    Test-Case 'baseline (applied): refused with exit 2; a baseline must precede the apply' ($rb2.ExitCode -eq 2 -and $rb2.Code -eq 'already_applied' -and -not (Test-Path (Join-Path $d0 'b2.json')))
    $rnb = Invoke-LabIsolation -Mode Applied -RepoRoot $script:RepoRoot -BaselinePath (Join-Path $d0 'none.json') -RecordPath (Join-Path $d0 'r2.json') -Log $quiet -Sleep $noSleep
    Test-Case 'applied without a baseline: exit 2 (baseline_missing), no container' ($rnb.ExitCode -eq 2 -and $rnb.Code -eq 'baseline_missing' -and @($f1.Calls | Where-Object { $_ -like 'create *' }).Count -eq 0)

    # ---------------------------------------------------------------- applied, compliant
    $ok = Invoke-Applied
    $fails = @($ok.R.Checks | Where-Object { $_['status'] -eq 'FAIL' })
    Test-Case 'applied (compliant): exit 0, no FAIL, every group A to D and F present' ($ok.R.ExitCode -eq 0 -and $fails.Count -eq 0 -and (@($ok.R.Checks | ForEach-Object { $_['group'] } | Sort-Object -Unique) -join ',') -ceq 'A,B,C,D,F') (($fails | ForEach-Object { "$($_['id'])=$(ConvertTo-Json $_['observed'] -Compress -Depth 6)" }) -join ' ; ')
    Test-Case 'applied (compliant): the controls ran and passed (health, closed port, IP control on legacy-internal, wrong member list, extra member seen, non-compliant fixture)' (@(@('A-C1', 'A-C2', 'B-C1', 'B-C2', 'B-C3', 'B-C4', 'C-C1', 'D-C1') | ForEach-Object { $ok.ById[$_]['status'] -eq 'PASS' -and $ok.ById[$_]['control'] } | Where-Object { -not $_ }).Count -eq 0)
    Test-Case 'applied (compliant): the external-route control is NOT MEASURED without -ExternalControl (no outbound traffic)' ($ok.ById['B-C5']['status'] -eq 'NOT MEASURED' -and @($ok.Fake.Calls | Where-Object { $_ -like '*extctl*' -and $_ -like 'create *' }).Count -eq 0)
    $recOk = ConvertFrom-JsonStrict -Text ([IO.File]::ReadAllText((Join-Path $ok.Dir 'record.json')))
    Test-Case 'applied (compliant): the record is written and passes the record format check' ($recOk['kind'] -ceq 'lab-isolation' -and (Test-IsolationRecord -Record $recOk).Count -eq 0)
    $created = @($ok.Fake.Calls | Where-Object { $_ -like 'create *' })
    Test-Case 'applied: only its own labelled probes are created (--pull never), each removed at the end; lab probe has the runtime network flags' ($created.Count -eq 2 -and @($created | Where-Object { $_ -notmatch 'phoenix\.discovery\.role=isolation-probe' -or $_ -notmatch '--pull never' }).Count -eq 0 -and $ok.Fake.Probes.Count -eq 0 -and ($created[0] -match "--network $lab --read-only --cap-drop ALL --security-opt no-new-privileges:true --user 10001:10001"))
    $verbs = @($ok.Fake.Calls | ForEach-Object { ($_ -split ' ')[0] } | Sort-Object -Unique)
    $started = @($ok.Fake.Calls | Where-Object { $_ -like 'start *' } | ForEach-Object { ($_ -split ' ')[1] })
    Test-Case 'applied: the only verbs are version, network inspect, ps, inspect, image inspect, create, start, logs, rm; start and rm only on its own probes' ((@($verbs | Where-Object { $_ -notin 'version', 'network', 'ps', 'inspect', 'image', 'create', 'start', 'logs', 'rm' })).Count -eq 0 -and @($started | Where-Object { $_ -notlike 'phoenix-isolation-*' }).Count -eq 0 -and @($ok.Fake.Calls | Where-Object { $_ -like 'rm *' -and $_ -notlike 'rm --force phoenix-isolation-*' }).Count -eq 0 -and @($ok.Fake.Calls | Where-Object { $_ -like 'network *' -and $_ -notlike 'network inspect *' }).Count -eq 0) ($verbs -join ',')

    # ---------------------------------------------------------------- applied, one violation each
    $cases = @(
        @{ Id = 'A1'; Name = 'the lab network is not internal'; Setup = { param($f) $f.Net.Internal = $false } }
        @{ Id = 'A2'; Name = 'IPv6 is enabled'; Setup = { param($f) $f.Net.EnableIPv6 = $true } }
        @{ Id = 'A4'; Name = 'an unexpected container is on the lab network'; Setup = { param($f) $f.ExtraMembers = @('intruder') } }
        @{ Id = 'A5'; Name = 'reverse-proxy is not on the lab network (two networks)'; Setup = { param($f) $f.Svc['reverse-proxy'].NetworkSettings.Networks.Remove($lab) } }
        @{ Id = 'A6-legacy-app'; Name = 'legacy-app joined the lab network'; Setup = { param($f) $f.Svc['legacy-app'].NetworkSettings.Networks[$lab] = @{ IPAddress = '172.30.0.9' } } }
        @{ Id = 'A7'; Name = 'reverse-proxy publishes 0.0.0.0:8056'; Setup = { param($f) $f.Svc['reverse-proxy'].HostConfig.PortBindings = @{ '8080/tcp' = @(@{ HostIp = '0.0.0.0'; HostPort = '8056' }) } } }
        @{ Id = 'D1'; Name = 'the runtime-equivalent probe has an added capability'; Setup = { param($f) $f.ProbeMutate = { param($j) $j.HostConfig.CapAdd = @('NET_RAW') } } }
        @{ Id = 'B3'; Name = 'legacy-app is reachable by IP although its name does not resolve (DNS failure alone is not accepted)'; Setup = { param($f) $f.Tcp['app-ip'] = 'connected' } }
        @{ Id = 'B4'; Name = 'legacy-db is reachable by IP'; Setup = { param($f) $f.Tcp['db-ip'] = 'connected' } }
        @{ Id = 'B6'; Name = 'the legacy-api address of reverse-proxy is reachable'; Setup = { param($f) $f.Tcp['proxy-legacy-api-ip'] = 'connected' } }
        @{ Id = 'B7'; Name = 'an external IP is reachable'; Setup = { param($f) $f.Tcp['ext-2'] = 'connected' } }
        @{ Id = 'B8'; Name = 'an external name resolves'; Setup = { param($f) $f.Dns['dns-external'] = @{ result = 'resolved'; addresses = @('93.184.215.14') } } }
        @{ Id = 'B10'; Name = 'the host gateway is reachable'; Setup = { param($f) $f.Tcp['gw-172.30.0.1-8056'] = 'connected' } }
        @{ Id = 'B11'; Name = 'another reverse-proxy port is open'; Setup = { param($f) $f.Scan = @{ host = 'reverse-proxy'; scanned = 1032; open = @(8080, 9000); counts = @{} } } }
        @{ Id = 'C-fwd-host-db'; Name = 'a request is forwarded to another destination'; Setup = { param($f) $f.Http['fwd-host-db'] = @{ result = 'response'; status = 200; appJson = $false; nginxDefault = $true } } }
        @{ Id = 'C-connect'; Name = 'CONNECT opens a tunnel'; Setup = { param($f) $f.Http['fwd-connect'] = @{ result = 'response'; status = 200; appJson = $false; nginxDefault = $false } } }
        @{ Id = 'B-C1'; Name = 'the health control fails (the probe is blind)'; Setup = { param($f) $f.Http['health'] = @{ result = 'blocked'; status = 0; appJson = $false; nginxDefault = $false } } }
        @{ Id = 'B-C4'; Name = 'the IP control on legacy-internal cannot connect (the method is blind)'; Setup = { param($f) $f.CtlTcp['ctl-app-ip'] = 'blocked' } }
        @{ Id = 'B-C2'; Name = 'a closed port is not observed as closed'; Setup = { param($f) $f.Tcp['proxy-9-closed-control'] = 'blocked' } }
    )
    foreach ($k in $cases) {
        $x = Invoke-Applied -Setup $k.Setup
        Test-Case "violation: $($k.Name) -> [$($k.Id)] FAIL, exit 1, probes removed" ($x.R.ExitCode -eq 1 -and $x.ById.ContainsKey($k.Id) -and $x.ById[$k.Id]['status'] -eq 'FAIL' -and $x.Fake.Probes.Count -eq 0) "exit=$($x.R.ExitCode) status=$(if ($x.ById.ContainsKey($k.Id)) { $x.ById[$k.Id]['status'] } else { 'absent' })"
    }
    $x = Invoke-Applied -ComposeSha ('0' * 64)
    Test-Case 'violation: infra/docker-compose.yml differs from the baseline hash -> [A8] FAIL' ($x.R.ExitCode -eq 1 -and $x.ById['A8']['status'] -eq 'FAIL')
    $x = Invoke-Applied -Setup { param($f) $f.Svc['legacy-app'].NetworkSettings.Networks = @{ 'project-phoenix_legacy-internal' = @{ IPAddress = '' } } }
    Test-Case 'unknown IP of legacy-app: [B3] FAIL (fail closed; never judged by the name check alone)' ($x.ById['B3']['status'] -eq 'FAIL')
    $x = Invoke-Applied -Setup { param($f) $f.Svc['reverse-proxy'].State.Running = $false }
    Test-Case 'services not running: exit 2, nothing started or created (the test never starts an existing container)' ($x.R.ExitCode -eq 2 -and $x.R.Code -eq 'services_not_running' -and @($x.Fake.Calls | Where-Object { $_ -like 'create *' -or $_ -like 'start *' }).Count -eq 0)
    $x = Invoke-Applied -Setup { param($f) $f.Probes['phoenix-isolation-probe-old'] = @{ Json = @{}; Network = $lab; Plan = @{}; Running = $false } }
    Test-Case 'a leftover probe from an earlier run: exit 2, it is not removed automatically' ($x.R.ExitCode -eq 2 -and $x.R.Code -eq 'probe_leftover' -and $x.Fake.Probes.ContainsKey('phoenix-isolation-probe-old'))

    # ---------------------------------------------------------------- result classes: a refusal is an IP-level answer (2026-11-14)
    $gwClosed = { param($f) foreach ($p in 8056, 80, 2375, 2376) { $f.Tcp["gw-172.30.0.1-$p"] = 'closed' } }
    $x = Invoke-Applied -Setup $gwClosed
    Test-Case 'gateway closed: B10 (no TCP connection) PASS, but B10-ip is RESIDUAL, never PASS; the run is not failed and the note names IP-level reachability' ($x.ById['B10']['status'] -eq 'PASS' -and $x.ById['B10-ip']['status'] -ceq 'RESIDUAL' -and $x.R.ExitCode -eq 0 -and $x.ById['B10-ip']['observed']['note'] -like '*reachable at the IP level*' -and @($x.ById['B10-ip']['observed']['answered']).Count -eq 4) "B10=$($x.ById['B10']['status']) B10-ip=$($x.ById['B10-ip']['status'])"
    $recX = ConvertFrom-JsonStrict -Text ([IO.File]::ReadAllText((Join-Path $x.Dir 'record.json')))
    Test-Case 'gateway closed: the record keeps RESIDUAL and passes the format check' (@($recX['checks'] | Where-Object { $_['id'] -eq 'B10-ip' -and $_['status'] -ceq 'RESIDUAL' }).Count -eq 1 -and (Test-IsolationRecord -Record $recX).Count -eq 0)
    $x = Invoke-Applied -Setup { param($f) foreach ($p in 8056, 80, 2375, 2376) { $f.Tcp["gw-172.30.0.1-$p"] = 'blocked' } }
    Test-Case 'gateway blocked (timeout, cause undetermined): B10-ip is RESIDUAL, not PASS' ($x.ById['B10-ip']['status'] -ceq 'RESIDUAL' -and $x.ById['B10-ip']['observed']['note'] -like '*cause undetermined*')
    $x = Invoke-Applied
    Test-Case 'gateway unreachable on every target: B10 and B10-ip PASS' ($x.ById['B10']['status'] -eq 'PASS' -and $x.ById['B10-ip']['status'] -eq 'PASS')
    $x = Invoke-Applied -Setup { param($f) $f.Tcp['gw-172.30.0.1-2375'] = 'connected' }
    Test-Case 'gateway connected: B10 and B10-ip FAIL, exit 1' ($x.ById['B10']['status'] -eq 'FAIL' -and $x.ById['B10-ip']['status'] -eq 'FAIL' -and $x.R.ExitCode -eq 1)
    $x = Invoke-Applied -Setup { param($f) $f.Tcp['hostname-gw-8056'] = 'connected' }
    Test-Case 'host.docker.internal connected: B10 FAIL' ($x.ById['B10']['status'] -eq 'FAIL' -and $x.R.ExitCode -eq 1)
    foreach ($k in @(@('app-ip', 'B3', 'connected'), @('db-ip', 'B4', 'connected'), @('app-ip', 'B3', 'closed'), @('db-ip', 'B4', 'closed'), @('app-name', 'B1', 'closed'), @('proxy-legacy-internal-ip', 'B5', 'closed'), @('ext-1', 'B7', 'closed'))) {
        $tid = $k[0]; $cls = $k[2]
        $x = Invoke-Applied -Setup ([scriptblock]::Create("param(`$f) `$f.Tcp['$tid'] = '$cls'"))
        Test-Case "$tid $cls -> [$($k[1])] FAIL (a refusal from a legacy, cross-network, or external address is an IP-level answer, not isolation)" ($x.ById[$k[1]]['status'] -eq 'FAIL' -and $x.R.ExitCode -eq 1) "status=$($x.ById[$k[1]]['status'])"
    }
    $x = Invoke-Applied -Setup { param($f) $f.Tcp['ext-3'] = 'blocked' }
    Test-Case 'an external IP that times out (blocked, cause undetermined) does not fail B7' ($x.ById['B7']['status'] -eq 'PASS')
    $x = Invoke-Applied -Setup $gwClosed
    Test-Case 'the external-route control stays NOT MEASURED without -ExternalControl (also when the gateway answers)' ($x.ById['B-C5']['status'] -ceq 'NOT MEASURED' -and $x.ById['B-C5']['control'] -eq $true)
    $nmList = Get-NotMeasuredChecks
    $badRes = @{ mode = 'Applied'; checks = @(@($nmList) + @(@{ group = 'B'; id = 'B3'; name = 'x'; status = 'RESIDUAL'; control = $false })) }
    Test-Case 'record format: RESIDUAL is rejected for any check other than B10-ip' ((Test-IsolationRecord -Record $badRes) -contains 'residual_not_allowed:B3')
    $ga = Get-GatewayAssessment -Results ([ordered]@{ 'gw-1-80' = 'closed'; 'gw-1-8056' = 'closed'; 'gw-1-2375' = 'closed'; 'gw-1-2376' = 'closed' })
    Test-Case 'assessment: four refusals give TCP PASS and IP level RESIDUAL; fewer than four gateway targets is a FAIL' ($ga.TcpConnection -eq 'PASS' -and $ga.IpLevel -ceq 'RESIDUAL' -and (Get-GatewayAssessment -Results ([ordered]@{ 'gw-1-80' = 'unreachable' })).IpLevel -eq 'FAIL')

    # ---------------------------------------------------------------- the supplementary re-evaluation never changes the applied evidence
    $dR = New-TempDir
    $srcRec = Join-Path $dR 'applied.json'
    $synthetic = [ordered]@{ checks = @([ordered]@{ control = $false; group = 'B'; id = 'B10'; name = 'x'; observed = [ordered]@{ results = @('gw-172.20.0.1-2375=closed', 'gw-172.20.0.1-2376=closed', 'gw-172.20.0.1-80=closed', 'gw-172.20.0.1-8056=closed', 'hostname-gw-80=dns_unresolved', 'hostname-gw-8056=dns_unresolved') }; status = 'PASS' }, [ordered]@{ control = $true; group = 'B'; id = 'B-C5'; name = 'x'; observed = $null; status = 'NOT MEASURED' }); kind = 'lab-isolation'; measuredAt = '2026-11-14T10:32:13.901+09:00'; mode = 'Applied'; schemaVersion = 1; statement = 'x' }
    [IO.File]::WriteAllText($srcRec, (ConvertTo-CanonicalJson -Value (ConvertFrom-JsonStrict -Text (ConvertTo-Json -InputObject $synthetic -Depth 10 -Compress))) + "`n")
    $before = [IO.File]::ReadAllBytes($srcRec)
    $re = Invoke-LabReevaluation -SourceRecord $srcRec -OutPath (Join-Path $dR 'reeval.json') -Decision 'test'
    $reRec = ConvertFrom-JsonStrict -Text ([IO.File]::ReadAllText((Join-Path $dR 'reeval.json')))
    Test-Case 're-evaluation: B10 PASS and B10-ip RESIDUAL from the recorded refusals; NOT MEASURED carried unchanged; the source is named by SHA-256' ($re.TcpConnection -eq 'PASS' -and $re.IpLevel -ceq 'RESIDUAL' -and @($reRec['notMeasuredCarried'] | Where-Object { $_['id'] -eq 'B-C5' -and $_['status'] -ceq 'NOT MEASURED' }).Count -eq 1 -and $reRec['source']['sha256'] -ceq (Get-Sha256Hex -Bytes $before))
    Test-Case 're-evaluation: the source record is byte-identical afterwards' (Test-BytesEqual $before ([IO.File]::ReadAllBytes($srcRec)))
    Test-Throws 're-evaluation: refuses to write over the source record' { Invoke-LabReevaluation -SourceRecord $srcRec -OutPath $srcRec } '*must not replace*'
    Test-Throws 're-evaluation: refuses to overwrite an existing supplementary record' { Invoke-LabReevaluation -SourceRecord $srcRec -OutPath (Join-Path $dR 'reeval.json') } '*exists already*'
    $realApplied = Join-Path $script:RepoRoot 'discovery/config/lab-isolation-applied.json'
    if (Test-Path -LiteralPath $realApplied) {
        Test-Case 'evidence: the applied record of 2026-11-14 is unchanged (SHA-256 12a14fa6...)' ((Get-Sha256HexOfFile -Path $realApplied) -ceq '12a14fa6f80551e8993f38f98a4ffd4932ed8dc7beedc32717fdf0f3501cf6db')
    } else { Write-Host 'NOT MEASURED: the local applied record is absent on this machine; its hash was not checked' -ForegroundColor Yellow }
    # ---------------------------------------------------------------- restored (group E)
    $dE = New-TempDir
    $logOk = Join-Path $dE 'legacy.log'; [IO.File]::WriteAllText($logOk, "PASS: T1`nResults: 57 passed, 0 failed`n")
    $fE = New-FakeLab -NotApplied
    $rE = Invoke-LabIsolation -Mode Restored -RepoRoot $script:RepoRoot -RecordPath (Join-Path $dE 'r.json') -LegacyTestLog $logOk -Log $quiet -Sleep $noSleep
    Test-Case 'restored: no lab network, two proxy networks, and a fresh passing legacy result -> exit 0' ($rE.ExitCode -eq 0 -and @($rE.Checks | Where-Object { $_['status'] -ne 'PASS' }).Count -eq 0)
    (Get-Item $logOk).LastWriteTimeUtc = [datetime]'2026-01-01'
    $rE2 = Invoke-LabIsolation -Mode Restored -RepoRoot $script:RepoRoot -RecordPath (Join-Path $dE 'r2.json') -LegacyTestLog $logOk -Log $quiet -Sleep $noSleep
    Test-Case 'restored: a legacy result older than the removal is a failure, not a skip' ($rE2.ExitCode -eq 1 -and @($rE2.Checks | Where-Object { $_['id'] -eq 'E3' -and $_['status'] -eq 'FAIL' }).Count -eq 1)
    $rE3 = Invoke-LabIsolation -Mode Restored -RepoRoot $script:RepoRoot -RecordPath (Join-Path $dE 'r3.json') -LegacyTestLog (Join-Path $dE 'missing.log') -Log $quiet -Sleep $noSleep
    Test-Case 'restored: a missing legacy result is a failure' ($rE3.ExitCode -eq 1)
    $logFail = Join-Path $dE 'legacy-fail.log'; [IO.File]::WriteAllText($logFail, "Results: 50 passed, 2 failed`n")
    $rE4 = Invoke-LabIsolation -Mode Restored -RepoRoot $script:RepoRoot -RecordPath (Join-Path $dE 'r4.json') -LegacyTestLog $logFail -Log $quiet -Sleep $noSleep
    Test-Case 'restored: a failing legacy result is a failure' ($rE4.ExitCode -eq 1)
    $fE5 = New-FakeLab
    [IO.File]::WriteAllText($logOk, "Results: 57 passed, 0 failed`n")
    $rE5 = Invoke-LabIsolation -Mode Restored -RepoRoot $script:RepoRoot -RecordPath (Join-Path $dE 'r5.json') -LegacyTestLog $logOk -Log $quiet -Sleep $noSleep
    Test-Case 'restored: the lab network still existing (or three proxy networks) is a failure; nothing is removed' ($rE5.ExitCode -eq 1 -and @($rE5.Checks | Where-Object { $_['id'] -in 'E1', 'E2' -and $_['status'] -eq 'FAIL' }).Count -eq 2 -and @($fE5.Calls | Where-Object { $_ -notmatch '^(version|network inspect|ps |inspect )' }).Count -eq 0)

    # ---------------------------------------------------------------- the entry script against the real environment is NOT run here
    Test-Case 'entry: Applied is the default mode and NOT APPLIED is reported with exit 3 (checked through the module above)' ($entrySrc.Contains("[string]`$Mode = 'Applied'") -and $modSrc.Contains("return (& `$done 3 'not_applied')"))
}