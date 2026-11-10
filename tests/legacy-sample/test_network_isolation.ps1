#Requires -Version 7.0
. (Join-Path $PSScriptRoot 'lib/common.ps1')

$script:Compose = @('compose', '-f', (Join-Path $script:RepoRoot 'infra/docker-compose.yml'), '--project-directory', $script:RepoRoot)
$script:CanaryName = 'phoenix-canary'
$script:ProxyImage = 'nginxinc/nginx-unprivileged:1.27-alpine'

function Get-ServiceId {
    param([string]$Service)
    $id = (& docker @script:Compose ps -q $Service 2>$null | Select-Object -First 1)
    if (-not $id) { throw "service not running: $Service" }
    "$id".Trim()
}

function Test-TcpViaBash {
    param([string]$Id, [string]$Ip, [int]$Port)
    $cmd = "timeout 5 bash -c 'exec 3<>/dev/tcp/{0}/{1}' >/dev/null 2>&1" -f $Ip, $Port
    & docker exec $Id sh -c $cmd 2>$null | Out-Null
    $LASTEXITCODE -eq 0
}

function Test-TcpViaNc {
    param([string]$Id, [string]$Ip, [int]$Port)
    & docker exec $Id nc -z -w 5 $Ip $Port 2>$null | Out-Null
    $LASTEXITCODE -eq 0
}

function Test-DnsResolves {
    param([string]$Id, [string]$Name)
    & docker exec $Id sh -c ("getent hosts {0} >/dev/null 2>&1" -f $Name) 2>$null | Out-Null
    $LASTEXITCODE -eq 0
}

function Test-HostTcp {
    param([string]$Ip, [int]$Port, [int]$TimeoutMs = 3000)
    $c = New-Object System.Net.Sockets.TcpClient
    try {
        $task = $c.ConnectAsync($Ip, $Port)
        if (-not $task.Wait($TimeoutMs)) { return $false }
        return $c.Connected
    } catch { return $false } finally { $c.Close() }
}

function Send-RawHttp {
    param([Parameter(Mandatory)][string]$Request, [int]$TimeoutMs = 5000)
    $client = New-Object System.Net.Sockets.TcpClient
    try {
        $client.Connect('127.0.0.1', 8056)
        $stream = $client.GetStream()
        $stream.ReadTimeout = $TimeoutMs
        $bytes = [Text.Encoding]::ASCII.GetBytes($Request)
        $stream.Write($bytes, 0, $bytes.Length)
        $sb = New-Object Text.StringBuilder
        $buf = New-Object byte[] 4096
        try {
            while (($n = $stream.Read($buf, 0, $buf.Length)) -gt 0) {
                [void]$sb.Append([Text.Encoding]::UTF8.GetString($buf, 0, $n))
                if ($sb.Length -gt 20000) { break }
            }
        } catch { }
        $sb.ToString()
    } finally { $client.Close() }
}

function Get-StatusCode {
    param([string]$Response)
    if ($Response -match '^HTTP/\d\.\d (\d{3})') { [int]$Matches[1] } else { 0 }
}

Invoke-TestMain {
    Write-Host '=== Network isolation (measured) ===' -ForegroundColor Cyan
    $app = Get-ServiceId 'legacy-app'
    $db = Get-ServiceId 'legacy-db'
    $proxy = Get-ServiceId 'reverse-proxy'

    # --- topology -----------------------------------------------------------------
    $netsApp = @((& docker inspect $app --format '{{range $k,$v := .NetworkSettings.Networks}}{{$k}} {{end}}').Trim() -split '\s+' | Sort-Object)
    $netsDb = @((& docker inspect $db --format '{{range $k,$v := .NetworkSettings.Networks}}{{$k}} {{end}}').Trim() -split '\s+' | Sort-Object)
    $netsProxy = @((& docker inspect $proxy --format '{{range $k,$v := .NetworkSettings.Networks}}{{$k}} {{end}}').Trim() -split '\s+' | Sort-Object)
    $internalName = $netsDb[0]
    Test-Case 'T1: legacy-app is connected to legacy-internal only' ($netsApp.Count -eq 1 -and $netsApp[0] -like '*legacy-internal') ($netsApp -join ',')
    Test-Case 'T2: legacy-db is connected to legacy-internal only' ($netsDb.Count -eq 1 -and $netsDb[0] -like '*legacy-internal') ($netsDb -join ',')
    Test-Case 'T3: reverse-proxy is connected to legacy-internal and legacy-api' (
        $netsProxy.Count -eq 2 -and ($netsProxy -like '*legacy-internal').Count -eq 1 -and ($netsProxy -like '*legacy-api').Count -eq 1
    ) ($netsProxy -join ',')
    $apiName = @($netsProxy | Where-Object { $_ -like '*legacy-api' })[0]
    Test-Case 'T4: legacy-internal is internal=true' ((& docker network inspect $internalName --format '{{.Internal}}') -eq 'true')
    Test-Case 'T5: legacy-api is a normal (non-internal) network' ((& docker network inspect $apiName --format '{{.Internal}}') -eq 'false')

    # --- published ports ------------------------------------------------------------
    $bindApp = (& docker inspect $app --format '{{json .HostConfig.PortBindings}}')
    $bindDb = (& docker inspect $db --format '{{json .HostConfig.PortBindings}}')
    $bindProxy = (& docker inspect $proxy --format '{{json .HostConfig.PortBindings}}') | ConvertFrom-Json
    $proxyHostPorts = @($bindProxy.PSObject.Properties | ForEach-Object { $_.Value })
    Test-Case 'T6: legacy-app publishes no port to the host' ($bindApp -eq '{}' -or $bindApp -eq 'null') $bindApp
    Test-Case 'T7: legacy-db publishes no port to the host' ($bindDb -eq '{}' -or $bindDb -eq 'null') $bindDb
    Test-Case 'T8: reverse-proxy publishes exactly one port, bound to 127.0.0.1:8056' (
        $proxyHostPorts.Count -eq 1 -and $proxyHostPorts[0].HostIp -eq '127.0.0.1' -and $proxyHostPorts[0].HostPort -eq '8056'
    ) ($bindProxy | ConvertTo-Json -Compress)
    $listen = @(Get-NetTCPConnection -State Listen -LocalPort 8056 -ErrorAction SilentlyContinue)
    if ($listen.Count -gt 0) {
        $wide = @($listen | Where-Object { $_.LocalAddress -in @('0.0.0.0', '::') })
        Test-Case 'T9: host listeners on port 8056 are loopback only' ($wide.Count -eq 0) (($listen | ForEach-Object { $_.LocalAddress }) -join ',')
    } else {
        Write-Host 'INFO: no host listener visible for port 8056 through Get-NetTCPConnection; T10/T11 are the measurement' -ForegroundColor Yellow
    }

    # --- proxy hardening (runtime) -------------------------------------------------------
    Test-Case 'T12: reverse-proxy runs unprivileged with read-only rootfs and no capabilities' (
        (& docker inspect $proxy --format '{{.Config.User}}') -eq '101' -and
        (& docker inspect $proxy --format '{{.HostConfig.ReadonlyRootfs}}') -eq 'true' -and
        (& docker inspect $proxy --format '{{.HostConfig.Privileged}}') -eq 'false' -and
        (& docker inspect $proxy --format '{{json .HostConfig.CapDrop}}') -eq '["ALL"]'
    )
    $mounts = @((& docker inspect $proxy --format '{{range .Mounts}}{{.Type}}:{{.Destination}}:{{.RW}};{{end}}').Trim(';') -split ';' | Where-Object { $_ })
    Test-Case 'T13: reverse-proxy mounts only its config (read-only) and a tmpfs /tmp' (
        $mounts.Count -eq 1 -and $mounts[0] -eq 'bind:/etc/nginx/nginx.conf:false'
    ) ($mounts -join ' | ')

    # --- static check of the proxy configuration -------------------------------------------
    $conf = Get-Content -Raw (Join-Path $script:RepoRoot 'infra/nginx/nginx.conf')
    $proxyPass = @([regex]::Matches($conf, 'proxy_pass\s+([^;]+);') | ForEach-Object { $_.Groups[1].Value.Trim() })
    Test-Case 'T14: nginx.conf has exactly one proxy_pass and its target is a fixed literal upstream' (
        $proxyPass.Count -eq 1 -and $proxyPass[0] -eq 'http://legacy_app' -and $proxyPass[0] -notmatch '\$'
    ) ($proxyPass -join ',')
    Test-Case 'T15: nginx.conf has one server, one location, no resolver, no status/admin endpoints, GET/POST only' (
        ([regex]::Matches($conf, '\bserver\s*\{')).Count -eq 1 -and
        ([regex]::Matches($conf, '\blocation\b')).Count -eq 1 -and
        $conf -notmatch '\bresolver\b' -and $conf -notmatch 'stub_status|autoindex|auth_|ssl|map\s|if\s*\(' -and
        $conf -match 'limit_except GET POST'
    )
    Test-Case 'T16: the only upstream server is legacy-app:80' (
        ((@([regex]::Matches($conf, '\bserver\s+(?!_)([^;{]+);') | ForEach-Object { $_.Groups[1].Value.Trim() }) -join ',') -eq 'legacy-app:80')
    )

    # --- host access --------------------------------------------------------------------------
    $h = Invoke-Api -Method GET -Path '/health'
    Test-Case 'T10: host 127.0.0.1:8056 reaches the API through the proxy (health 200, db ok)' ($h.Status -eq 200 -and $h.Body.data.db -eq 'ok') $h.Raw
    $nonLoop = @([System.Net.NetworkInformation.NetworkInterface]::GetAllNetworkInterfaces() |
        ForEach-Object { $_.GetIPProperties().UnicastAddresses } |
        Where-Object { $_.Address.AddressFamily -eq 'InterNetwork' -and -not [System.Net.IPAddress]::IsLoopback($_.Address) } |
        ForEach-Object { $_.Address.ToString() } | Sort-Object -Unique)
    Write-Host ("INFO: host non-loopback IPv4 addresses checked: " + ($nonLoop -join ', ')) -ForegroundColor Yellow
    foreach ($ip in $nonLoop) {
        Test-Case "T11: host address ${ip}:8056 does NOT reach the API" (-not (Test-HostTcp $ip 8056))
    }
    Test-Case 'T11b: at least one non-loopback host address was measured' ($nonLoop.Count -ge 1)
    Write-Host ("INFO: host [::1]:8056 reachable = " + (Test-HostTcp '::1' 8056)) -ForegroundColor Yellow

    # --- positive controls (a probe must be able to report CONNECTED) ---------------------------
    Test-Case 'C1: control - legacy-app can open TCP to legacy-db:3306' (Test-TcpViaBash $app 'legacy-db' 3306)
    Test-Case 'C2: control - legacy-db can open TCP to legacy-app:80 (same probe method as the external tests)' (Test-TcpViaBash $db 'legacy-app' 80)
    Test-Case 'C3: control - reverse-proxy can open TCP to legacy-app:80' (Test-TcpViaNc $proxy 'legacy-app' 80)
    Test-Case 'C4: control - the API works end to end (proxy -> app -> db)' ((Invoke-Api -Method GET -Path '/products').Body.data.Count -eq 5)

    # --- external reachability, direct IP (no DNS involved) --------------------------------------
    $externals = @(@('1.1.1.1', 53), @('8.8.8.8', 53), @('1.1.1.1', 443), @('9.9.9.9', 443))
    foreach ($e in $externals) {
        Test-Case "E1: legacy-app cannot open TCP to $($e[0]):$($e[1]) (direct IP)" (-not (Test-TcpViaBash $app $e[0] $e[1]))
        Test-Case "E2: legacy-db cannot open TCP to $($e[0]):$($e[1]) (direct IP)" (-not (Test-TcpViaBash $db $e[0] $e[1]))
    }
    Test-Case 'E3: legacy-app cannot resolve an external name' (-not (Test-DnsResolves $app 'example.com'))
    Test-Case 'E4: legacy-db cannot resolve an external name' (-not (Test-DnsResolves $db 'example.com'))

    # --- proxy cannot be used to reach arbitrary destinations -----------------------------------
    & docker rm -f $script:CanaryName 2>$null | Out-Null
    & docker run -d --rm --name $script:CanaryName --network $apiName --entrypoint nginx $script:ProxyImage -g 'daemon off;' 2>&1 | Out-Null
    try {
        $ready = $false
        for ($i = 0; $i -lt 10 -and -not $ready; $i++) {
            Start-Sleep -Milliseconds 700
            & docker exec $proxy wget -q -O /dev/null "http://${script:CanaryName}:8080/?CONTROL-MARKER" 2>$null
            $ready = ($LASTEXITCODE -eq 0)
        }
        Test-Case 'P0: control - the proxy container itself can reach a canary on legacy-api (so a leak would be visible)' $ready
        Start-Sleep -Milliseconds 500
        $logsControl = (& docker logs $script:CanaryName 2>&1) -join "`n"
        Test-Case 'P0b: control - the canary logs a request it receives' ($logsControl -match 'CONTROL-MARKER')

        $canaryIp = (& docker inspect $script:CanaryName --format '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}').Trim()
        Test-Case 'P1: legacy-app cannot reach the canary (no route between the networks)' (-not (Test-TcpViaBash $app $canaryIp 8080))

        $cn = "${script:CanaryName}:8080"
        $attacks = [ordered]@{
            'absolute-URI'      = "GET http://$cn/ATTACK-1 HTTP/1.1`r`nHost: $cn`r`nConnection: close`r`n`r`n"
            'Host header'       = "GET /ATTACK-2 HTTP/1.1`r`nHost: $cn`r`nConnection: close`r`n`r`n"
            'double slash path' = "GET //$cn/ATTACK-3 HTTP/1.1`r`nHost: localhost`r`nConnection: close`r`n`r`n"
            'override headers'  = "GET /ATTACK-4 HTTP/1.1`r`nHost: localhost`r`nX-Forwarded-Host: $cn`r`nX-Original-URL: http://$cn/ATTACK-4`r`nX-Accel-Redirect: http://$cn/ATTACK-4`r`nConnection: close`r`n`r`n"
            'absolute-URI POST' = "POST http://$cn/ATTACK-5 HTTP/1.1`r`nHost: $cn`r`nContent-Length: 2`r`nConnection: close`r`n`r`n{}"
            'raw IP host'       = "GET /ATTACK-6 HTTP/1.1`r`nHost: 1.1.1.1`r`nConnection: close`r`n`r`n"
            'encoded traversal' = "GET /%2e%2e/%2e%2e/ATTACK-7 HTTP/1.1`r`nHost: $cn`r`nConnection: close`r`n`r`n"
        }
        foreach ($k in $attacks.Keys) {
            $resp = Send-RawHttp $attacks[$k]
            $code = Get-StatusCode $resp
            Test-Case "P2: '$k' is not forwarded to the canary (response is not the canary page)" ($resp -notmatch 'Welcome to nginx' -and $code -ne 0) "status=$code"
        }
        foreach ($m in 'PUT', 'DELETE', 'PATCH', 'OPTIONS') {
            $resp = Send-RawHttp "$m /ATTACK-8 HTTP/1.1`r`nHost: $cn`r`nContent-Length: 0`r`nConnection: close`r`n`r`n"
            Test-Case "P3: method $m is rejected by the proxy (403/405)" ((Get-StatusCode $resp) -in @(403, 405)) ("status=" + (Get-StatusCode $resp))
        }
        $respC = Send-RawHttp "CONNECT $cn HTTP/1.1`r`nHost: $cn`r`nConnection: close`r`n`r`n"
        Test-Case 'P4: CONNECT is not accepted (no tunnel)' ((Get-StatusCode $respC) -in @(400, 403, 405, 501)) ("status=" + (Get-StatusCode $respC))
        $appPaths = @('/nginx_status', '/status', '/metrics')
        $allApp = $true
        foreach ($ap in $appPaths) {
            $r = Invoke-Api -Method GET -Path $ap
            if (-not ($r.Status -eq 404 -and $r.Body.success -eq $false)) { $allApp = $false }
        }
        Test-Case 'P5a: status-style paths are answered by the app as 404 JSON (the proxy has no endpoints of its own)' $allApp
        $ss = Invoke-WebRequest -Uri "http://127.0.0.1:8056/server-status" -UseBasicParsing -SkipHttpErrorCheck -TimeoutSec 10
        Test-Case 'P5b: Apache mod_status (/server-status) is not served through the proxy (refused, not 200)' ([int]$ss.StatusCode -in @(403, 404)) ("status=" + [int]$ss.StatusCode)
        Write-Host ("INFO: /server-status exists in the legacy-app image (Apache mod_status, local-only by default); through the proxy it answers " + [int]$ss.StatusCode) -ForegroundColor Yellow

        Start-Sleep -Seconds 2
        $logsAfter = (& docker logs $script:CanaryName 2>&1) -join "`n"
        $leaks = @([regex]::Matches($logsAfter, 'ATTACK-\d') | ForEach-Object { $_.Value } | Sort-Object -Unique)
        Test-Case 'P6: the canary received none of the crafted requests' ($leaks.Count -eq 0) ("seen: " + ($leaks -join ','))
        $requestLines = @([regex]::Matches($logsAfter, '"(GET|POST|PUT|DELETE|PATCH|OPTIONS|CONNECT|HEAD) [^"]*"'))
        Test-Case 'P7: the canary saw exactly one request in total, and it is the control request' ($requestLines.Count -eq 1 -and $requestLines[0].Value -match 'CONTROL-MARKER') ("count=" + $requestLines.Count)
    } finally {
        & docker rm -f $script:CanaryName 2>$null | Out-Null
    }

    # --- known residual (measured, informational) -----------------------------------------------------
    $proxyEgress = Test-TcpViaNc $proxy '1.1.1.1' 53
    Write-Host ("INFO: reverse-proxy container itself -> 1.1.1.1:53 = " + $(if ($proxyEgress) { 'CONNECTED (it sits on the non-internal legacy-api network; it runs only the fixed-upstream nginx)' } else { 'BLOCKED' })) -ForegroundColor Yellow
}
