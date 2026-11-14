#Requires -Version 7.0
# Discovery_Override isolation test (R18.21 to R18.28, task 4.15; brought forward before 2.19). Used by
# tests/discovery-loop/test_discovery_network_isolation.ps1. Every Docker call goes through Invoke-DockerCli (DiscoveryLauncher.psm1),
# so the unit tests replace it with a fake.
#
# The test NEVER changes the configuration: no compose up/down, no network create/rm/connect/disconnect, no volume, no start, stop,
# restart, or exec of an existing container. It only reads (inspect, ps, version) and creates, runs, and removes its OWN short-lived
# probe containers (label phoenix.discovery.role=isolation-probe, --pull never). A failure is reported; nothing is repaired.
#
# Configuration checks (docker inspect) and traffic checks (probe connections) are reported as separate groups. A name that does not
# resolve is never taken as "unreachable": every destination is also tried by IP address, and a positive control shows that the
# method can observe the opposite result.
Set-StrictMode -Version Latest
Import-Module (Join-Path $PSScriptRoot '../../../discovery/tools/DiscoveryCommon.psm1') -DisableNameChecking
Import-Module (Join-Path $PSScriptRoot '../../../discovery/tools/DiscoveryLauncher.psm1') -DisableNameChecking

$script:Lab = 'phoenix-discovery-lab'
$script:Project = 'project-phoenix'
$script:ProbeImage = 'phoenix/discovery-toolchain:m0'
$script:ProbeRole = 'phoenix.discovery.role=isolation-probe'
$script:ProbeMountTarget = '/probe'
$script:ExternalTcp = @(@('1.1.1.1', 53), @('1.1.1.1', 443), @('8.8.8.8', 53), @('9.9.9.9', 443))
$script:NotMeasured = @(
    @{ id = 'F-udp'; name = 'UDP paths from discovery-lab' }
    @{ id = 'F-icmp'; name = 'ICMP paths from discovery-lab' }
    @{ id = 'F-ipv6'; name = 'IPv6 paths from the probe (IPv6 is disabled on the network; no IPv6 connection is attempted)' }
    @{ id = 'F-other-hosts'; name = 'other hosts on the host network or LAN beyond the checked gateway addresses' }
    @{ id = 'F-symlink'; name = 'symbolic-link checks' }
    @{ id = 'F-hardlink'; name = 'hard-link checks' }
    @{ id = 'F-proxy-outbound'; name = 'outbound traffic of reverse-proxy through legacy-api (remains; the override does not remove it)' }
)
# Statuses. RESIDUAL (2026-11-14): measured, and the result shows a path at the IP level that is not proven safe (for example a TCP
# refusal from the gateway). It is never PASS and never NOT MEASURED; it does not fail the run, and it is listed separately so a human
# decides. It is allowed only for the checks in $script:ResidualIds.
$script:Statuses = @('PASS', 'FAIL', 'NOT MEASURED', 'RESIDUAL')
$script:ResidualIds = @('B10-ip')
# Result classes of labProbe.cjs:
#   connected      TCP connection established
#   closed         connection refused: something at that IP answered (IP-level reachability)
#   blocked        timeout: no answer, cause undetermined
#   unreachable    no route, or an unreachable report
#   dns_unresolved name resolution failed (name targets only)

function Get-LabIsolationConstants { [pscustomobject]@{ Lab = $script:Lab; ProbeImage = $script:ProbeImage; ProbeRole = $script:ProbeRole; NotMeasured = $script:NotMeasured } }

function New-Check {
    param([string]$Group, [string]$Id, [string]$Name, [ValidateSet('PASS', 'FAIL', 'NOT MEASURED', 'RESIDUAL')][string]$Status, $Observed = $null, [switch]$Control)
    [ordered]@{ control = [bool]$Control; group = $Group; id = $Id; name = $Name; observed = $Observed; status = $Status }
}
function New-Bool { param([string]$Group, [string]$Id, [string]$Name, [bool]$Ok, $Observed = $null, [switch]$Control) New-Check -Group $Group -Id $Id -Name $Name -Status $(if ($Ok) { 'PASS' } else { 'FAIL' }) -Observed $Observed -Control:$Control }

# ------------------------------------------------------------------------------------------------ reading (no change)
function Get-JsonOf {
    param([string[]]$Arguments)
    $r = Invoke-DockerCli -Arguments $Arguments
    if ($r.ExitCode -ne 0) { return $null }
    $t = $r.Output.Trim(); if (-not $t) { return $null }
    $o = ConvertFrom-JsonStrict -Text $t
    if ($o -is [System.Collections.IList] -and $o -isnot [string]) { if ($o.Count -eq 0) { return $null }; return $o[0] }
    $o
}
function Get-LabNetwork { Get-JsonOf @('network', 'inspect', $script:Lab, '--format', '{{json .}}') }
function Get-ServiceContainerId {
    param([string]$Service)
    $r = Invoke-DockerCli -Arguments @('ps', '-a', '-q', '--filter', "label=com.docker.compose.project=$script:Project", '--filter', "label=com.docker.compose.service=$Service")
    $ids = @($r.Output -split "`n" | ForEach-Object { $_.Trim() } | Where-Object { $_ })
    if ($ids.Count -eq 1) { $ids[0] } else { $null }
}
function Get-ContainerJson { param([string]$Id) Get-JsonOf @('inspect', $Id, '--format', '{{json .}}') }
function Get-NetworkNames { param($C) if ($null -eq $C) { return @() }; @($C['NetworkSettings']['Networks'].Keys | Sort-Object) }
function Get-PortText { param($C) if ($null -eq $C -or $null -eq $C['HostConfig']['PortBindings']) { return '{}' }; ConvertTo-CanonicalJson -Value $C['HostConfig']['PortBindings'] }   # canonical: independent of key order
function Get-ProxyPorts {
    param($C)
    $out = @()
    $pb = $C['HostConfig']['PortBindings']
    if ($null -ne $pb) { foreach ($k in $pb.Keys) { foreach ($b in @($pb[$k])) { $out += "$($b['HostIp']):$($b['HostPort'])->$k" } } }
    , @($out | Sort-Object)
}
function Get-IpOn { param($C, [string]$NetworkLike) foreach ($k in $C['NetworkSettings']['Networks'].Keys) { if ($k -like $NetworkLike) { return [string]$C['NetworkSettings']['Networks'][$k]['IPAddress'] } }; $null }

function Get-ServiceState {
    $s = [ordered]@{}
    foreach ($svc in 'reverse-proxy', 'legacy-app', 'legacy-db') { $id = Get-ServiceContainerId -Service $svc; $s[$svc] = if ($id) { Get-ContainerJson -Id $id } else { $null } }
    $s
}

# ------------------------------------------------------------------------------------------------ baseline (before apply)
function New-LabBaseline {
    param([Parameter(Mandatory)][string]$RepoRoot)
    $st = Get-ServiceState
    foreach ($k in $st.Keys) { if ($null -eq $st[$k]) { throw "service container not found: $k" } }
    [ordered]@{
        composeSha256 = Get-Sha256HexOfFile -Path (Join-Path $RepoRoot 'infra/docker-compose.yml')
        kind = 'lab-isolation-baseline'
        overrideSha256 = Get-Sha256HexOfFile -Path (Join-Path $RepoRoot 'infra/docker-compose.discovery.yml')
        schemaVersion = [long]1
        services = [ordered]@{
            'legacy-app' = [ordered]@{ networks = @(Get-NetworkNames $st['legacy-app']); ports = Get-PortText $st['legacy-app'] }
            'legacy-db' = [ordered]@{ networks = @(Get-NetworkNames $st['legacy-db']); ports = Get-PortText $st['legacy-db'] }
            'reverse-proxy' = [ordered]@{ networks = @(Get-NetworkNames $st['reverse-proxy']); ports = Get-PortText $st['reverse-proxy'] }
        }
        takenAt = [DateTimeOffset]::Now.ToString("yyyy-MM-dd'T'HH:mm:ss.fffzzz", [System.Globalization.CultureInfo]::InvariantCulture)
    }
}

# ------------------------------------------------------------------------------------------------ group A: topology (configuration)
function Compare-Members {
    param([string[]]$Actual, [string[]]$Expected)
    $a = @($Actual | Sort-Object -Unique); $e = @($Expected | Sort-Object -Unique)
    [pscustomobject]@{ Equal = (($a -join ',') -ceq ($e -join ',')); Extra = @($a | Where-Object { $e -notcontains $_ }); Missing = @($e | Where-Object { $a -notcontains $_ }) }
}

function Get-LabMemberNames { param($Net) if ($null -eq $Net -or $null -eq $Net['Containers']) { return @() }; @($Net['Containers'].Values | ForEach-Object { [string]$_['Name'] } | Sort-Object) }

function Test-Topology {
    param([Parameter(Mandatory)]$Net, [Parameter(Mandatory)]$State, [Parameter(Mandatory)]$Baseline, [Parameter(Mandatory)][string]$RepoRoot, [string[]]$ExpectedMembers)
    $c = [System.Collections.Generic.List[object]]::new()
    $c.Add((New-Bool A 'A1' 'phoenix-discovery-lab is internal (Internal = true)' ($Net['Internal'] -eq $true) ([ordered]@{ internal = $Net['Internal'] })))
    $v6 = $Net['EnableIPv6']; $v6Subnets = @($Net['IPAM']['Config'] | Where-Object { [string]$_['Subnet'] -match ':' })
    $c.Add((New-Bool A 'A2' 'IPv6 is disabled on phoenix-discovery-lab (EnableIPv6 = false, no IPv6 subnet)' ($v6 -eq $false -and $v6Subnets.Count -eq 0) ([ordered]@{ enableIPv6 = $v6; ipv6Subnets = $v6Subnets.Count })))
    $c.Add((New-Bool A 'A3' 'phoenix-discovery-lab is a bridge network with the override label' ($Net['Driver'] -ceq 'bridge' -and $null -ne $Net['Labels'] -and $Net['Labels']['phoenix.discovery.network'] -ceq 'discovery-lab') ([ordered]@{ driver = $Net['Driver'] })))
    $proxyName = if ($State['reverse-proxy']) { ([string]$State['reverse-proxy']['Name']).TrimStart('/') } else { '' }
    $exp = @($proxyName) + @($ExpectedMembers)
    $mem = Compare-Members -Actual (Get-LabMemberNames $Net) -Expected $exp
    $c.Add((New-Bool A 'A4' 'the members of phoenix-discovery-lab are exactly reverse-proxy plus the expected probe' $mem.Equal ([ordered]@{ extra = $mem.Extra; missing = $mem.Missing })))
    $pn = @(Get-NetworkNames $State['reverse-proxy'])
    $c.Add((New-Bool A 'A5' 'reverse-proxy has exactly three networks: legacy-internal, legacy-api, phoenix-discovery-lab' ($pn.Count -eq 3 -and ($pn -contains $script:Lab) -and @($pn | Where-Object { $_ -like '*legacy-internal' }).Count -eq 1 -and @($pn | Where-Object { $_ -like '*legacy-api' }).Count -eq 1) ([ordered]@{ networks = $pn })))
    foreach ($svc in 'legacy-app', 'legacy-db') {
        $now = @(Get-NetworkNames $State[$svc]); $was = @($Baseline['services'][$svc]['networks'])
        $c.Add((New-Bool A "A6-$svc" "$svc keeps the network membership of the baseline and is not on phoenix-discovery-lab" ($null -ne $State[$svc] -and (($now -join ',') -ceq ($was -join ',')) -and -not ($now -contains $script:Lab)) ([ordered]@{ baseline = $was; now = $now })))
    }
    $portsOk = $true; $pobs = [ordered]@{}
    foreach ($svc in 'reverse-proxy', 'legacy-app', 'legacy-db') { $now = Get-PortText $State[$svc]; $was = [string]$Baseline['services'][$svc]['ports']; $pobs[$svc] = [ordered]@{ baseline = $was; now = $now }; if ($now -cne $was) { $portsOk = $false } }
    $pp = Get-ProxyPorts $State['reverse-proxy']
    $c.Add((New-Bool A 'A7' 'published ports are unchanged; reverse-proxy publishes exactly 127.0.0.1:8056 -> 8080/tcp; legacy-app and legacy-db publish none' ($portsOk -and (($pp -join ',') -ceq '127.0.0.1:8056->8080/tcp') -and (Get-PortText $State['legacy-app']) -in @('{}', 'null') -and (Get-PortText $State['legacy-db']) -in @('{}', 'null')) ([ordered]@{ proxy = $pp; services = $pobs })))
    $hash = Get-Sha256HexOfFile -Path (Join-Path $RepoRoot 'infra/docker-compose.yml')
    $c.Add((New-Bool A 'A8' 'infra/docker-compose.yml has the baseline hash (the base file is unchanged)' ($hash -ceq $Baseline['composeSha256']) ([ordered]@{ baseline = $Baseline['composeSha256']; now = $hash })))
    # positive control: a comparison against a deliberately wrong expected list must fail
    $wrong = Compare-Members -Actual (Get-LabMemberNames $Net) -Expected (@($exp) + @('phoenix-deliberately-absent-member'))
    $c.Add((New-Bool A 'A-C1' 'control: the member comparison fails against a deliberately wrong expected list' (-not $wrong.Equal -and ($wrong.Missing -contains 'phoenix-deliberately-absent-member')) $null -Control))
    , $c.ToArray()
}

# ------------------------------------------------------------------------------------------------ group D: runtime rights (configuration)
# Returns the list of violated properties of a container definition (docker inspect JSON). Empty list = compliant.
function Get-RuntimeRightsViolations {
    param([Parameter(Mandatory)]$C, [Parameter(Mandatory)][string]$Network, [string[]]$AllowedMountTargets = @())
    $v = [System.Collections.Generic.List[string]]::new()
    $h = $C['HostConfig']; $cfg = $C['Config']
    $nets = @($C['NetworkSettings']['Networks'].Keys)
    if ($nets.Count -ne 1 -or $nets[0] -cne $Network -or [string]$h['NetworkMode'] -cne $Network) { $v.Add('network') }
    $user = [string]$cfg['User']
    if (-not $user -or $user -eq '0' -or $user -like '0:*' -or $user -eq 'root' -or $user -like 'root:*') { $v.Add('user') }
    if ($h['Privileged'] -ne $false) { $v.Add('privileged') }
    $drop = @($h['CapDrop']); $add = @($h['CapAdd'] | Where-Object { $_ })
    if (-not ($drop -contains 'ALL')) { $v.Add('cap_drop') }
    if ($add.Count -gt 0) { $v.Add('cap_add') }
    $mounts = @($C['Mounts'])
    foreach ($m in $mounts) {
        if ([string]$m['Source'] -match 'docker\.sock' -or [string]$m['Destination'] -match 'docker\.sock') { if (-not $v.Contains('docker_socket')) { $v.Add('docker_socket') } }
        if ($AllowedMountTargets -cnotcontains [string]$m['Destination']) { if (-not $v.Contains('mount_not_allowed')) { $v.Add('mount_not_allowed') } }
    }
    $pb = $h['PortBindings']
    if (($null -ne $pb -and $pb.Count -gt 0) -or $h['PublishAllPorts'] -eq $true) { $v.Add('published_port') }
    if (-not ([long]$h['Memory'] -gt 0)) { $v.Add('memory_limit') }
    if (-not ([long]$h['NanoCpus'] -gt 0)) { $v.Add('cpu_limit') }
    if (-not ($null -ne $h['PidsLimit'] -and [long]$h['PidsLimit'] -gt 0)) { $v.Add('pids_limit') }
    if ($h['ReadonlyRootfs'] -ne $true) { $v.Add('read_only_root') }
    if (-not (@($h['SecurityOpt']) | Where-Object { $_ -match '^no-new-privileges(:true|=true)?$' })) { $v.Add('no_new_privileges') }
    , $v.ToArray()
}

# The negative fixture of R18.26: a deliberately non-compliant definition; the same check must report every listed property.
function Get-NonCompliantFixture {
    @{
        Config = @{ User = 'root' }
        HostConfig = @{ NetworkMode = 'bridge'; Privileged = $true; CapDrop = @(); CapAdd = @('NET_ADMIN'); PortBindings = @{ '8080/tcp' = @(@{ HostIp = '0.0.0.0'; HostPort = '8080' }) }; PublishAllPorts = $false
            Memory = 0; NanoCpus = 0; PidsLimit = $null; ReadonlyRootfs = $false; SecurityOpt = @() }
        Mounts = @(@{ Type = 'bind'; Source = '/var/run/docker.sock'; Destination = '/var/run/docker.sock'; RW = $true })
        NetworkSettings = @{ Networks = @{ 'phoenix-discovery-lab' = @{}; 'project-phoenix_legacy-api' = @{} } }
    }
}
function Get-NonCompliantExpected { @('network', 'user', 'privileged', 'cap_drop', 'cap_add', 'docker_socket', 'mount_not_allowed', 'published_port', 'memory_limit', 'cpu_limit', 'pids_limit', 'read_only_root', 'no_new_privileges') }

function Test-RuntimeRights {
    param($ProbeJson, $Fixture = (Get-NonCompliantFixture), [string[]]$FixtureExpected = (Get-NonCompliantExpected))
    $c = [System.Collections.Generic.List[object]]::new()
    if ($null -eq $ProbeJson) { $c.Add((New-Check D 'D1' 'runtime-equivalent probe definition passes the rights check' 'FAIL' ([ordered]@{ reason = 'probe not inspectable' }))) }
    else {
        $viol = Get-RuntimeRightsViolations -C $ProbeJson -Network $script:Lab -AllowedMountTargets @($script:ProbeMountTarget)
        $c.Add((New-Bool D 'D1' 'runtime-equivalent probe: lab network only, non-root, not privileged, all capabilities dropped, no added capability, only the allowed read-only mount, no Docker socket, no published port, memory/CPU/pids limits, read-only root, no-new-privileges' ($viol.Count -eq 0) ([ordered]@{ violations = $viol })))
        $ro = @($ProbeJson['Mounts'] | Where-Object { $_['RW'] -ne $false }).Count -eq 0
        $c.Add((New-Bool D 'D2' 'every mount of the probe is read-only' $ro $null))
    }
    $fv = Get-RuntimeRightsViolations -C $Fixture -Network $script:Lab -AllowedMountTargets @($script:ProbeMountTarget)
    $missing = @($FixtureExpected | Where-Object { $fv -notcontains $_ })
    $c.Add((New-Bool D 'D-C1' 'control: the same check reports every property of the deliberately non-compliant fixture (root user, extra network, Docker socket, published port, no limits, ...)' ($missing.Count -eq 0) ([ordered]@{ notReported = $missing; reported = $fv }) -Control))
    , $c.ToArray()
}

# ------------------------------------------------------------------------------------------------ probes (traffic)
function New-ProbeCreateArgs {
    param([Parameter(Mandatory)][string]$Name, [Parameter(Mandatory)][string]$Network, [Parameter(Mandatory)][string]$PlanJson, [Parameter(Mandatory)][string]$ProbeDir)
    @('create', '--pull', 'never', '--name', $Name, '--label', $script:ProbeRole, '--network', $Network, '--read-only', '--cap-drop', 'ALL',
        '--security-opt', 'no-new-privileges:true', '--user', '10001:10001', '--tmpfs', '/tmp:rw,size=16m', '--memory', '256m', '--cpus', '0.5', '--pids-limit', '64',
        '--env', "PHOENIX_PROBE_PLAN=$PlanJson", '--mount', "type=bind,source=$ProbeDir,target=$script:ProbeMountTarget,readonly",
        $script:ProbeImage, 'node', "$script:ProbeMountTarget/labProbe.cjs")
}

function Wait-OwnContainer {
    param([string]$Name, [int]$TimeoutMs = 180000, [scriptblock]$Sleep = { param($ms) Start-Sleep -Milliseconds $ms })
    $sw = [System.Diagnostics.Stopwatch]::StartNew()
    while ($sw.ElapsedMilliseconds -lt $TimeoutMs) {
        $r = Invoke-DockerCli -Arguments @('inspect', '--format', '{{.State.Running}}', $Name)
        if ($r.ExitCode -ne 0 -or $r.Output.Trim() -ne 'true') { return $true }
        & $Sleep 500
    }
    $false
}

function Read-ProbeResult {
    param([string]$Name)
    $logs = (Invoke-DockerCli -Arguments @('logs', $Name)).Output
    $line = @($logs -split "`n" | Where-Object { $_ -like 'PROBE-RESULT *' } | Select-Object -Last 1)
    if ($line.Count -eq 0) { return $null }
    ConvertFrom-JsonStrict -Text $line[0].Substring('PROBE-RESULT '.Length)
}

function New-LabPlan {
    param([Parameter(Mandatory)]$Facts)
    $tcp = [System.Collections.Generic.List[object]]::new()
    $tcp.Add(@{ id = 'proxy-8080-name'; host = 'reverse-proxy'; port = 8080 })
    $tcp.Add(@{ id = 'proxy-9-closed-control'; host = 'reverse-proxy'; port = 9 })
    $tcp.Add(@{ id = 'app-name'; host = 'legacy-app'; port = 80 }); $tcp.Add(@{ id = 'db-name'; host = 'legacy-db'; port = 3306 })
    if ($Facts.AppIp) { $tcp.Add(@{ id = 'app-ip'; host = $Facts.AppIp; port = 80 }) }
    if ($Facts.DbIp) { $tcp.Add(@{ id = 'db-ip'; host = $Facts.DbIp; port = 3306 }) }
    if ($Facts.ProxyInternalIp) { $tcp.Add(@{ id = 'proxy-legacy-internal-ip'; host = $Facts.ProxyInternalIp; port = 8080 }) }
    if ($Facts.ProxyApiIp) { $tcp.Add(@{ id = 'proxy-legacy-api-ip'; host = $Facts.ProxyApiIp; port = 8080 }) }
    $i = 0; foreach ($e in $script:ExternalTcp) { $i++; $tcp.Add(@{ id = "ext-$i"; host = $e[0]; port = $e[1] }) }
    foreach ($gw in @($Facts.Gateways)) { foreach ($p in 8056, 80, 2375, 2376) { $tcp.Add(@{ id = "gw-$gw-$p"; host = $gw; port = $p }) } }
    foreach ($p in 8056, 80) { $tcp.Add(@{ id = "hostname-gw-$p"; host = 'host.docker.internal'; port = $p }) }
    foreach ($t in $tcp) { $t['timeoutMs'] = 3000 }
    $dnsNames = @(@{ id = 'dns-external'; name = 'example.com' }, @{ id = 'dns-legacy-app'; name = 'legacy-app' }, @{ id = 'dns-legacy-db'; name = 'legacy-db' }, @{ id = 'dns-host-gateway'; name = 'host.docker.internal' }, @{ id = 'dns-proxy'; name = 'reverse-proxy' })
    $req = { param($line, $hostHeader) "$line HTTP/1.1`r`nHost: $hostHeader`r`nConnection: close`r`n`r`n" }
    $http = @(
        @{ id = 'health'; host = 'reverse-proxy'; port = 8080; request = (& $req 'GET /health' 'reverse-proxy') }
        @{ id = 'fwd-absolute-external'; host = 'reverse-proxy'; port = 8080; request = (& $req 'GET http://1.1.1.1/PHX-FWD-1' '1.1.1.1') }
        @{ id = 'fwd-host-db'; host = 'reverse-proxy'; port = 8080; request = (& $req 'GET /PHX-FWD-2' 'legacy-db:3306') }
        @{ id = 'fwd-absolute-db'; host = 'reverse-proxy'; port = 8080; request = (& $req 'GET http://legacy-db:3306/PHX-FWD-3' 'legacy-db:3306') }
        @{ id = 'fwd-connect'; host = 'reverse-proxy'; port = 8080; request = (& $req 'CONNECT 1.1.1.1:443' '1.1.1.1:443') }
    )
    $ports = [System.Collections.Generic.List[int]]::new(); foreach ($p in 1..1024) { $ports.Add($p) }; foreach ($p in 3306, 8056, 8080, 8081, 8443, 9000, 9090, 9113) { if (-not $ports.Contains($p)) { $ports.Add($p) } }
    [ordered]@{ dns = $dnsNames; http = $http; scan = @{ host = 'reverse-proxy'; ports = $ports.ToArray(); timeoutMs = 1500; concurrency = 64 }; startDelayMs = 4000; tcp = $tcp.ToArray() }
}

function New-ControlPlan {
    param([Parameter(Mandatory)]$Facts)
    $tcp = @()
    if ($Facts.AppIp) { $tcp += @{ id = 'ctl-app-ip'; host = $Facts.AppIp; port = 80; timeoutMs = 3000 } }
    if ($Facts.DbIp) { $tcp += @{ id = 'ctl-db-ip'; host = $Facts.DbIp; port = 3306; timeoutMs = 3000 } }
    [ordered]@{ dns = @(@{ id = 'ctl-dns-legacy-app'; name = 'legacy-app' }); http = @(); scan = $null; startDelayMs = 0; tcp = $tcp }
}

# No TCP connection was established (any other class). Used only where a refusal is expected and harmless (the gateway TCP check).
function Test-Negative { param($r) $r -in @('blocked', 'closed', 'unreachable', 'dns_unresolved') }
# Isolated at the IP level: nothing answered. A refusal (closed) is an answer from that address, so it is NOT isolation.
function Test-IpIsolated { param($r, [switch]$Name) $ok = @('blocked', 'unreachable'); if ($Name) { $ok += 'dns_unresolved' }; $r -in $ok }

# The gateway assessment from the raw TCP results of the gateway targets (gw-<ip>-<port> and hostname-gw-<port>).
# TcpConnection: PASS if no connection was established, FAIL otherwise.
# IpLevel: FAIL if connected; RESIDUAL if any address answered (closed) or did not answer (blocked: cause undetermined); PASS only if
# every target reported unreachable (or, for the host name, did not resolve). A refusal is never taken as IP-level isolation.
function Get-GatewayAssessment {
    param([Parameter(Mandatory)][System.Collections.IDictionary]$Results)
    $ids = @($Results.Keys | Where-Object { $_ -like 'gw-*' -or $_ -like 'hostname-gw-*' } | Sort-Object)
    $ip = @($ids | Where-Object { $_ -like 'gw-*' })
    $classes = [ordered]@{}; foreach ($k in $ids) { $classes[$k] = [string]$Results[$k] }
    $connected = @($ids | Where-Object { $Results[$_] -ceq 'connected' })
    $answered = @($ids | Where-Object { $Results[$_] -ceq 'closed' })
    $silent = @($ids | Where-Object { $Results[$_] -ceq 'blocked' })
    $other = @($ids | Where-Object { $Results[$_] -cnotin @('connected', 'closed', 'blocked', 'unreachable', 'dns_unresolved') })
    $tcp = if ($ip.Count -lt 4) { 'FAIL' } elseif ($connected.Count -gt 0 -or $other.Count -gt 0) { 'FAIL' } else { 'PASS' }
    $lvl = if ($ip.Count -lt 4 -or $connected.Count -gt 0 -or $other.Count -gt 0) { 'FAIL' } elseif ($answered.Count -gt 0 -or $silent.Count -gt 0) { 'RESIDUAL' } else { 'PASS' }
    $note = if ($answered.Count -gt 0) { 'the gateway address answered (TCP refusal): it is reachable at the IP level; only the listed ports were tried, so an unknown service on that address may be reachable' } elseif ($silent.Count -gt 0) { 'no answer (timeout): cause undetermined, not proof of isolation' } elseif ($lvl -eq 'PASS') { 'every target reported no route' } else { 'a TCP connection was established or a result is unknown' }
    [pscustomobject]@{ TcpConnection = $tcp; IpLevel = $lvl; Classes = $classes; Answered = $answered; Connected = $connected; Silent = $silent; Note = $note }
}

function ConvertTo-TrafficChecks {
    param($Lab, $Ctl, $Facts, [bool]$ExternalControl, $ExtCtl)
    $c = [System.Collections.Generic.List[object]]::new()
    if ($null -eq $Lab) { $c.Add((New-Check B 'B0' 'the lab probe produced a result' 'FAIL' ([ordered]@{ reason = 'no PROBE-RESULT line' }))); return , $c.ToArray() }
    $t = $Lab['tcp']; $get = { param($k) if ($t.Contains($k)) { [string]$t[$k] } else { 'not_run' } }
    $h = $Lab['http']['health']
    $c.Add((New-Bool B 'B-C1' 'control: the probe reaches the reverse-proxy:8080 health endpoint (HTTP 200, db ok)' ($null -ne $h -and $h['status'] -eq 200 -and $h['dbOk'] -eq $true) $h -Control))
    $c.Add((New-Bool B 'B-C2' 'control: a closed port of reverse-proxy is observed as closed (the method can see a refusal)' ((& $get 'proxy-9-closed-control') -ceq 'closed') (& $get 'proxy-9-closed-control') -Control))
    $c.Add((New-Bool B 'B-C3' 'control: TCP to reverse-proxy:8080 by name is connected' ((& $get 'proxy-8080-name') -ceq 'connected') (& $get 'proxy-8080-name') -Control))
    $ctlOk = $null -ne $Ctl -and $Ctl['tcp'].Count -ge 2 -and @($Ctl['tcp'].Values | Where-Object { $_ -ne 'connected' }).Count -eq 0
    $c.Add((New-Bool B 'B-C4' 'control: the same probe on legacy-internal reaches legacy-app and legacy-db by IP (the IP method can observe a reachable path)' $ctlOk $(if ($Ctl) { $Ctl['tcp'] } else { $null }) -Control))
    foreach ($pair in @(@('B1', 'app-name', 'legacy-app:80 by name'), @('B2', 'db-name', 'legacy-db:3306 by name'))) { $c.Add((New-Bool B $pair[0] "the probe cannot reach $($pair[2]) (no answer; a refusal would mean the host answered)" (Test-IpIsolated (& $get $pair[1]) -Name) (& $get $pair[1]))) }
    foreach ($pair in @(@('B3', 'app-ip', 'legacy-app:80 by IP', $Facts.AppIp), @('B4', 'db-ip', 'legacy-db:3306 by IP', $Facts.DbIp))) {
        if (-not $pair[3]) { $c.Add((New-Check B $pair[0] "the probe cannot reach $($pair[2])" 'FAIL' ([ordered]@{ reason = 'IP address unknown; a DNS failure alone is not taken as unreachable' }))) }
        else { $c.Add((New-Bool B $pair[0] "the probe cannot reach $($pair[2]) ($($pair[3])) at the IP level (unreachable or no answer; a refusal or a connection is a FAIL)" (Test-IpIsolated (& $get $pair[1])) (& $get $pair[1]))) }
    }
    foreach ($pair in @(@('B5', 'proxy-legacy-internal-ip', 'the legacy-internal address of reverse-proxy'), @('B6', 'proxy-legacy-api-ip', 'the legacy-api address of reverse-proxy'))) {
        $r = & $get $pair[1]; $c.Add((New-Bool B $pair[0] "the probe cannot reach $($pair[2]) (no route across networks; a refusal is a FAIL)" ($r -cne 'not_run' -and (Test-IpIsolated $r)) $r))
    }
    $ext = @($t.Keys | Where-Object { $_ -like 'ext-*' } | Sort-Object)
    $c.Add((New-Bool B 'B7' 'the probe cannot reach external IP destinations (1.1.1.1:53/443, 8.8.8.8:53, 9.9.9.9:443; no DNS involved; unreachable or no answer, a refusal is a FAIL)' ($ext.Count -eq 4 -and @($ext | Where-Object { -not (Test-IpIsolated $t[$_]) }).Count -eq 0) ([ordered]@{ results = @($ext | ForEach-Object { "$_=$($t[$_])" }) })))
    if ($ExternalControl) { $c.Add((New-Bool B 'B-C5' 'control: a container on legacy-api reaches an external IP (the method can observe external reachability)' ($null -ne $ExtCtl -and $ExtCtl['tcp']['ext-ctl'] -ceq 'connected') $(if ($ExtCtl) { $ExtCtl['tcp'] } else { $null }) -Control)) }
    else { $c.Add((New-Check B 'B-C5' 'control: external reachability observable from a non-internal network' 'NOT MEASURED' ([ordered]@{ reason = 'needs outbound traffic; run with -ExternalControl only with approval' }) -Control)) }
    $d = $Lab['dns']
    $c.Add((New-Bool B 'B8' 'the probe cannot resolve an external DNS name (example.com)' ($null -ne $d['dns-external'] -and $d['dns-external']['result'] -cne 'resolved') $d['dns-external']))
    foreach ($n in 'dns-legacy-app', 'dns-legacy-db') { $c.Add((New-Bool B "B9-$n" "the probe cannot resolve $($n.Substring(4)) (judged together with the IP check, never alone)" ($null -ne $d[$n] -and $d[$n]['result'] -cne 'resolved') $d[$n])) }
    $ga = Get-GatewayAssessment -Results $t
    $gwObs = [ordered]@{ answered = $ga.Answered; classes = $ga.Classes; connected = $ga.Connected; note = $ga.Note; silent = $ga.Silent }
    $c.Add((New-Check B 'B10' 'no TCP connection to the host gateway (network gateway address and host.docker.internal on 8056, 80, 2375, 2376); this is NOT a statement of IP-level isolation (see B10-ip)' $(if (@($Facts.Gateways).Count -lt 1) { 'FAIL' } else { $ga.TcpConnection }) $gwObs))
    $c.Add((New-Check B 'B10-ip' 'IP-level isolation of the host gateway: PASS only if no route is reported; a refusal (closed) or no answer (blocked) is RESIDUAL, a connection is FAIL' $(if (@($Facts.Gateways).Count -lt 1) { 'FAIL' } else { $ga.IpLevel }) $gwObs))
    $s = $Lab['scan']
    $c.Add((New-Bool B 'B11' 'reverse-proxy has no reachable port other than 8080 (ports 1-1024 and 3306, 8056, 8081, 8443, 9000, 9090, 9113)' ($null -ne $s -and ((@($s['open']) -join ',') -ceq '8080') -and $s['scanned'] -ge 1024) $s))
    # group C: forwarding through reverse-proxy
    $hc = $Lab['http']
    $c.Add((New-Bool C 'C-C1' 'control: a request through reverse-proxy to its configured upstream succeeds (health 200)' ($null -ne $h -and $h['status'] -eq 200) $null -Control))
    foreach ($k in 'fwd-absolute-external', 'fwd-host-db', 'fwd-absolute-db') {
        $x = $hc[$k]; $c.Add((New-Bool C "C-$k" "request '$k' is answered by the fixed upstream legacy-app (app JSON), not forwarded to the named destination" ($null -ne $x -and $x['result'] -ceq 'response' -and ($x['appJson'] -eq $true -or $x['status'] -eq 400) -and $x['nginxDefault'] -ne $true) $x))
    }
    $cx = $hc['fwd-connect']
    $c.Add((New-Bool C 'C-connect' 'CONNECT through reverse-proxy is refused (no tunnel)' ($null -ne $cx -and $cx['status'] -in @(400, 403, 405, 501)) $cx))
    $c.Add((New-Bool C 'C-host' 'the host does not forward lab traffic to external destinations (same evidence as B7 and B10; the IP-level gateway result is B10-ip)' (@($c | Where-Object { $_['id'] -in @('B7', 'B10') -and $_['status'] -ne 'PASS' }).Count -eq 0) $null))
    , $c.ToArray()
}

function Invoke-OwnProbe {
    param([string]$Name, [string]$Network, $Plan, [string]$ProbeDir, [scriptblock]$OnRunning, [scriptblock]$Sleep)
    $json = ConvertTo-Json -InputObject $Plan -Compress -Depth 16
    $created = (Invoke-DockerCli -Arguments (New-ProbeCreateArgs -Name $Name -Network $Network -PlanJson $json -ProbeDir $ProbeDir)).ExitCode -eq 0
    if (-not $created) { return [pscustomobject]@{ Created = $false; Inspect = $null; Result = $null; DuringRun = $null } }
    $inspect = Get-ContainerJson -Id $Name
    $during = $null
    if ((Invoke-DockerCli -Arguments @('start', $Name)).ExitCode -eq 0) {
        if ($OnRunning) { $during = & $OnRunning }
        [void](Wait-OwnContainer -Name $Name -Sleep $Sleep)
    }
    [pscustomobject]@{ Created = $true; Inspect = $inspect; Result = (Read-ProbeResult -Name $Name); DuringRun = $during }
}

# ------------------------------------------------------------------------------------------------ the record
function Test-IsolationRecord {
    param([Parameter(Mandatory)]$Record)
    $p = [System.Collections.Generic.List[string]]::new()
    foreach ($c in @($Record['checks'])) {
        if ($script:Statuses -cnotcontains [string]$c['status']) { $p.Add("status:$($c['id'])") }
        if ($c['group'] -ceq 'F' -and $c['status'] -cne 'NOT MEASURED') { $p.Add("F_not_measured_only:$($c['id'])") }
        if ($c['group'] -ceq 'B' -and -not $c['control'] -and $c['status'] -ceq 'NOT MEASURED') { $p.Add("B_measured_only:$($c['id'])") }
        if ($c['status'] -ceq 'RESIDUAL' -and $script:ResidualIds -cnotcontains [string]$c['id']) { $p.Add("residual_not_allowed:$($c['id'])") }
    }
    $ids = @($Record['checks'] | Where-Object { $_['group'] -ceq 'F' } | ForEach-Object { $_['id'] })
    # every record of the applied state lists every unmeasured path; the restoration record (group E only) has none
    if ([string]$Record['mode'] -cne 'Restored') { foreach ($n in $script:NotMeasured) { if ($ids -cnotcontains $n.id) { $p.Add("F_missing:$($n.id)") } } }
    , $p.ToArray()
}

function Get-NotMeasuredChecks { , @($script:NotMeasured | ForEach-Object { New-Check F $_.id $_.name 'NOT MEASURED' ([ordered]@{ assumedBlocked = $false }) }) }

# ------------------------------------------------------------------------------------------------ re-evaluation of an existing record
# Re-evaluates the gateway results of an existing applied record with the current classification, without any Docker call and without
# changing the source record. The output is a separate supplementary record that names the source by path and SHA-256.
function Invoke-LabReevaluation {
    [CmdletBinding()]
    param([Parameter(Mandatory)][string]$SourceRecord, [Parameter(Mandatory)][string]$OutPath, [string]$Decision)
    if ([System.IO.Path]::GetFullPath($SourceRecord) -ieq [System.IO.Path]::GetFullPath($OutPath)) { throw 'the supplementary record must not replace the source record' }
    if (Test-Path -LiteralPath $OutPath) { throw "the supplementary record exists already: $OutPath" }
    $bytes = [System.IO.File]::ReadAllBytes($SourceRecord)
    $src = ConvertFrom-JsonStrict -Text ([System.Text.UTF8Encoding]::new($false, $true).GetString($bytes))
    if ($src['kind'] -cne 'lab-isolation' -or $src['mode'] -cne 'Applied') { throw 'the source is not an applied lab-isolation record' }
    $b10 = @($src['checks'] | Where-Object { $_['id'] -ceq 'B10' })
    if ($b10.Count -ne 1) { throw 'the source has no B10 check' }
    $results = [ordered]@{}
    foreach ($e in @($b10[0]['observed']['results'])) { $kv = ([string]$e).Split('=', 2); $results[$kv[0]] = $kv[1] }
    $ga = Get-GatewayAssessment -Results $results
    $gwObs = [ordered]@{ answered = $ga.Answered; classes = $ga.Classes; connected = $ga.Connected; note = $ga.Note; silent = $ga.Silent }
    $carried = @($src['checks'] | Where-Object { $_['status'] -ceq 'NOT MEASURED' } | ForEach-Object { [ordered]@{ id = $_['id']; status = 'NOT MEASURED' } })
    $rec = [ordered]@{
        checks = @(
            (New-Check B 'B10' 'no TCP connection to the host gateway; NOT a statement of IP-level isolation' $ga.TcpConnection $gwObs)
            (New-Check B 'B10-ip' 'IP-level isolation of the host gateway' $ga.IpLevel $gwObs)
        )
        decision = $Decision
        kind = 'lab-isolation-reevaluation'
        notMeasuredCarried = $carried
        reevaluatedAt = [DateTimeOffset]::Now.ToString("yyyy-MM-dd'T'HH:mm:ss.fffzzz", [System.Globalization.CultureInfo]::InvariantCulture)
        schemaVersion = [long]1
        source = [ordered]@{ measuredAt = $src['measuredAt']; path = $SourceRecord; sha256 = Get-Sha256Hex -Bytes $bytes }
        statement = 'Re-evaluation of recorded results only; no new measurement. A refusal from the gateway is IP-level reachability, not isolation. NOT MEASURED paths stay NOT MEASURED.'
    }
    $d = Split-Path -Parent $OutPath; if (-not (Test-Path -LiteralPath $d)) { [void][System.IO.Directory]::CreateDirectory($d) }
    Write-TextAtomically -Path $OutPath -Text ((ConvertTo-CanonicalJson -Value (ConvertFrom-JsonStrict -Text (ConvertTo-Json -InputObject $rec -Depth 32 -Compress))) + "`n")
    [pscustomobject]@{ OutPath = $OutPath; TcpConnection = $ga.TcpConnection; IpLevel = $ga.IpLevel; SourceSha256 = $rec.source.sha256 }
}

# ------------------------------------------------------------------------------------------------ entry
function Invoke-LabIsolation {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)][ValidateSet('Baseline', 'Applied', 'Restored')][string]$Mode,
        [Parameter(Mandatory)][string]$RepoRoot, [string]$BaselinePath, [string]$RecordPath, [string]$LegacyTestLog,
        [switch]$ExternalControl, [scriptblock]$Log = { param($m) Write-Host $m }, [scriptblock]$Sleep = { param($ms) Start-Sleep -Milliseconds $ms }
    )
    if (-not $BaselinePath) { $BaselinePath = Join-Path $RepoRoot 'discovery/config/lab-isolation-baseline.json' }
    if (-not $RecordPath) { $RecordPath = Join-Path $RepoRoot "discovery/config/lab-isolation-$($Mode.ToLowerInvariant()).json" }
    $done = { param($exit, $code, $checks = @())
        foreach ($x in @($checks)) { & $Log ("{0}: [{1}] {2}" -f $x['status'], $x['id'], $x['name']) }
        [pscustomobject]@{ ExitCode = $exit; Code = $code; Checks = @($checks); RecordPath = $(if ($exit -le 1 -and @($checks).Count) { $RecordPath } else { $null }) } }
    $writeRecord = { param($checks)
        $rec = [ordered]@{ checks = @($checks); kind = 'lab-isolation'; measuredAt = [DateTimeOffset]::Now.ToString("yyyy-MM-dd'T'HH:mm:ss.fffzzz", [System.Globalization.CultureInfo]::InvariantCulture); mode = $Mode; schemaVersion = [long]1
            statement = 'Measured under the recorded conditions only. A path recorded NOT MEASURED is not assumed blocked (R18.10, R18.28).' }
        $bad = Test-IsolationRecord -Record $rec
        if ($bad.Count -gt 0) { throw "record format violation: $($bad -join ',')" }
        $d = Split-Path -Parent $RecordPath; if (-not (Test-Path -LiteralPath $d)) { [void][System.IO.Directory]::CreateDirectory($d) }
        Write-TextAtomically -Path $RecordPath -Text ((ConvertTo-CanonicalJson -Value (ConvertFrom-JsonStrict -Text (ConvertTo-Json -InputObject $rec -Depth 32 -Compress))) + "`n") }
    if ((Invoke-DockerCli -Arguments @('version', '--format', '{{.Server.Version}}')).ExitCode -ne 0) { & $Log 'refused: the Docker daemon is not reachable'; return (& $done 2 'docker_unavailable') }
    $net = Get-LabNetwork

    if ($Mode -eq 'Baseline') {
        if ($null -ne $net) { & $Log 'refused: phoenix-discovery-lab exists; the baseline must be taken before the override is applied'; return (& $done 2 'already_applied') }
        $b = New-LabBaseline -RepoRoot $RepoRoot
        $d = Split-Path -Parent $BaselinePath; if (-not (Test-Path -LiteralPath $d)) { [void][System.IO.Directory]::CreateDirectory($d) }
        Write-TextAtomically -Path $BaselinePath -Text ((ConvertTo-CanonicalJson -Value (ConvertFrom-JsonStrict -Text (ConvertTo-Json -InputObject $b -Depth 16 -Compress))) + "`n")
        & $Log "NOT APPLIED (expected before 2.19): phoenix-discovery-lab does not exist; baseline written to $BaselinePath"
        return [pscustomobject]@{ ExitCode = 0; Code = 'baseline_written'; Checks = @(); RecordPath = $BaselinePath }
    }

    if ($Mode -eq 'Restored') {
        $st = Get-ServiceState
        $checks = [System.Collections.Generic.List[object]]::new()
        $checks.Add((New-Bool E 'E1' 'phoenix-discovery-lab no longer exists' ($null -eq $net) $null))
        $pn = @(Get-NetworkNames $st['reverse-proxy'])
        $checks.Add((New-Bool E 'E2' 'reverse-proxy has exactly two networks: legacy-internal and legacy-api' ($pn.Count -eq 2 -and @($pn | Where-Object { $_ -like '*legacy-internal' }).Count -eq 1 -and @($pn | Where-Object { $_ -like '*legacy-api' }).Count -eq 1) ([ordered]@{ networks = $pn })))
        $created = if ($st['reverse-proxy']) { [DateTimeOffset]::Parse([string]$st['reverse-proxy']['Created']).UtcDateTime } else { $null }
        $logOk = $false; $obs = [ordered]@{ log = $LegacyTestLog }
        if ($LegacyTestLog -and (Test-Path -LiteralPath $LegacyTestLog -PathType Leaf) -and $null -ne $created) {
            $txt = [System.IO.File]::ReadAllText($LegacyTestLog); $fresh = (Get-Item -LiteralPath $LegacyTestLog).LastWriteTimeUtc -gt $created
            $passed = $txt -match '(?m)^Results: [1-9][0-9]* passed, 0 failed'
            $obs['fresh'] = $fresh; $obs['passed'] = $passed; $logOk = $fresh -and $passed
        }
        $checks.Add((New-Bool E 'E3' 'tests/legacy-sample/test_network_isolation.ps1 was run after the removal and passed (a missing or older result file is a failure, never a skip)' $logOk $obs))
        $all = $checks.ToArray(); & $writeRecord $all
        return (& $done $(if (@($all | Where-Object { $_['status'] -eq 'FAIL' }).Count) { 1 } else { 0 }) 'restored_checked' $all)
    }

    # Applied
    if ($null -eq $net) { & $Log 'NOT APPLIED: phoenix-discovery-lab does not exist. This is the expected state before task 2.19; the applied-state test does not run (R18.21).'; return (& $done 3 'not_applied') }
    if (-not (Test-Path -LiteralPath $BaselinePath -PathType Leaf)) { & $Log "refused: no baseline at $BaselinePath (take it with -Mode Baseline before applying)"; return (& $done 2 'baseline_missing') }
    $baseline = ConvertFrom-JsonStrict -Text ([System.IO.File]::ReadAllText($BaselinePath))
    $st = Get-ServiceState
    foreach ($k in $st.Keys) { if ($null -eq $st[$k]) { & $Log "refused: service container not found: $k"; return (& $done 2 'service_missing') } }
    if (-not $st['reverse-proxy']['State']['Running'] -or -not $st['legacy-app']['State']['Running'] -or -not $st['legacy-db']['State']['Running']) { & $Log 'refused: reverse-proxy, legacy-app, and legacy-db must be running; this test never starts or recreates them'; return (& $done 2 'services_not_running') }
    if ((Invoke-DockerCli -Arguments @('image', 'inspect', '--format', '{{.Id}}', $script:ProbeImage)).ExitCode -ne 0) { & $Log "refused: the probe image $script:ProbeImage is not present locally (it is never pulled)"; return (& $done 2 'probe_image_missing') }
    $leftover = @((Invoke-DockerCli -Arguments @('ps', '-a', '-q', '--filter', "label=$script:ProbeRole")).Output -split "`n" | Where-Object { $_.Trim() })
    if ($leftover.Count -gt 0) { & $Log 'refused: isolation-probe containers already exist; remove them by hand after review'; return (& $done 2 'probe_leftover') }

    $checks = [System.Collections.Generic.List[object]]::new()
    foreach ($x in (Test-Topology -Net $net -State $st -Baseline $baseline -RepoRoot $RepoRoot -ExpectedMembers @())) { $checks.Add($x) }
    $facts = [pscustomobject]@{
        AppIp = Get-IpOn $st['legacy-app'] '*legacy-internal'; DbIp = Get-IpOn $st['legacy-db'] '*legacy-internal'
        ProxyInternalIp = Get-IpOn $st['reverse-proxy'] '*legacy-internal'; ProxyApiIp = Get-IpOn $st['reverse-proxy'] '*legacy-api'
        Gateways = @(@($net['IPAM']['Config']) | ForEach-Object { [string]$_['Gateway'] } | Where-Object { $_ })
    }
    $internalNet = @(Get-NetworkNames $st['legacy-db'] | Where-Object { $_ -like '*legacy-internal' })[0]
    $apiNet = @(Get-NetworkNames $st['reverse-proxy'] | Where-Object { $_ -like '*legacy-api' })[0]
    $probeDir = [System.IO.Path]::GetFullPath($PSScriptRoot)
    $sfx = [Convert]::ToHexString([System.Security.Cryptography.RandomNumberGenerator]::GetBytes(4)).ToLowerInvariant()
    $names = @("phoenix-isolation-probe-$sfx", "phoenix-isolation-control-$sfx", "phoenix-isolation-extctl-$sfx")
    try {
        $labRun = Invoke-OwnProbe -Name $names[0] -Network $script:Lab -Plan (New-LabPlan -Facts $facts) -ProbeDir $probeDir -Sleep $Sleep -OnRunning {
            & $Sleep 1500
            Test-Topology -Net (Get-LabNetwork) -State $st -Baseline $baseline -RepoRoot $RepoRoot -ExpectedMembers @()
        }
        # positive control of A4: with the probe attached, the comparison against "reverse-proxy only" must report it as extra
        $a4During = @($labRun.DuringRun | Where-Object { $_['id'] -eq 'A4' })
        $extraSeen = $a4During.Count -eq 1 -and $a4During[0]['status'] -eq 'FAIL' -and (@($a4During[0]['observed']['extra']) -contains $names[0])
        $checks.Add((New-Bool A 'A-C2' 'control: a deliberately attached extra container (the probe) is reported by the member check' $extraSeen $(if ($a4During.Count) { $a4During[0]['observed'] } else { $null }) -Control))
        foreach ($x in (Test-RuntimeRights -ProbeJson $labRun.Inspect)) { $checks.Add($x) }
        $ctlRun = Invoke-OwnProbe -Name $names[1] -Network $internalNet -Plan (New-ControlPlan -Facts $facts) -ProbeDir $probeDir -Sleep $Sleep
        $extRun = $null
        if ($ExternalControl) { $extRun = Invoke-OwnProbe -Name $names[2] -Network $apiNet -Plan ([ordered]@{ dns = @(); http = @(); scan = $null; startDelayMs = 0; tcp = @(@{ id = 'ext-ctl'; host = '1.1.1.1'; port = 443; timeoutMs = 3000 }) }) -ProbeDir $probeDir -Sleep $Sleep }
        foreach ($x in (ConvertTo-TrafficChecks -Lab $labRun.Result -Ctl $ctlRun.Result -Facts $facts -ExternalControl ([bool]$ExternalControl) -ExtCtl $(if ($extRun) { $extRun.Result } else { $null }))) { $checks.Add($x) }
    } finally {
        foreach ($n in $names) { [void](Invoke-DockerCli -Arguments @('rm', '--force', $n)) }
    }
    $after = Test-Topology -Net (Get-LabNetwork) -State (Get-ServiceState) -Baseline $baseline -RepoRoot $RepoRoot -ExpectedMembers @()
    $a4After = @($after | Where-Object { $_['id'] -eq 'A4' })[0]
    $checks.Add((New-Check A 'A9' 'after the probes are removed, the members are again exactly reverse-proxy' $a4After['status'] $a4After['observed']))
    foreach ($x in (Get-NotMeasuredChecks)) { $checks.Add($x) }
    $all = $checks.ToArray()
    & $writeRecord $all
    & $done $(if (@($all | Where-Object { $_['status'] -eq 'FAIL' }).Count) { 1 } else { 0 }) 'applied_checked' $all
}

Export-ModuleMember -Function Get-GatewayAssessment, Invoke-LabReevaluation, Get-LabIsolationConstants, Compare-Members, Get-LabMemberNames, Test-Topology, Get-RuntimeRightsViolations, Get-NonCompliantFixture, Get-NonCompliantExpected, Test-RuntimeRights, New-ProbeCreateArgs, New-LabPlan, New-ControlPlan, ConvertTo-TrafficChecks, Test-IsolationRecord, Get-NotMeasuredChecks, New-LabBaseline, Invoke-LabIsolation