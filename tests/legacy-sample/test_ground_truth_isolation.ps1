#Requires -Version 7.0
# Task 4.3 / R9.4: the Ground Truth is not reachable through the running system.
# HTTP probes are sent as raw requests over TCP so that dot segments and encoded traversal
# sequences reach the proxy unchanged (Invoke-WebRequest would normalize them away).
. (Join-Path $PSScriptRoot 'lib/common.ps1')

function Invoke-RawHttp {
    param([Parameter(Mandatory)][string]$RawPath)
    $u = [Uri]$script:BaseUrl
    $client = New-Object System.Net.Sockets.TcpClient
    try {
        $client.ReceiveTimeout = 10000; $client.SendTimeout = 10000
        $client.Connect($u.Host, $u.Port)
        $stream = $client.GetStream()
        $req = "GET $RawPath HTTP/1.1`r`nHost: $($u.Host):$($u.Port)`r`nConnection: close`r`n`r`n"
        $bytes = [Text.Encoding]::ASCII.GetBytes($req)
        $stream.Write($bytes, 0, $bytes.Length)
        $ms = New-Object IO.MemoryStream
        $stream.CopyTo($ms)
        $text = [Text.Encoding]::UTF8.GetString($ms.ToArray())
        $status = if ($text -match '^HTTP/1\.[01] (\d{3})') { [int]$Matches[1] } else { 0 }
        [pscustomobject]@{ Status = $status; Text = $text }
    } finally { $client.Dispose() }
}

function Get-ProjectContainers {
    $compose = Join-Path $script:RepoRoot 'infra/docker-compose.yml'
    $ids = @(& docker compose -f $compose --project-directory $script:RepoRoot ps -q 2>$null | ForEach-Object { "$_".Trim() } | Where-Object { $_ })
    $ids
}

function Invoke-InContainer {
    param([string]$Id, [string]$Script)
    $out = & docker exec $Id sh -c $Script 2>&1
    (($out | ForEach-Object { "$_" }) -join "`n").Trim()
}

Invoke-TestMain {
    $gt = Get-Content -Raw (Join-Path $script:RepoRoot 'evaluation/ground-truth/ground-truth.json') | ConvertFrom-Json -Depth 40
    $canary = [string]$gt.meta.canary
    $prefix = 'PHOENIX-GT-CANARY'

    # --- HTTP ---
    $h = Invoke-RawHttp '/health'
    Test-Case 'GI1 raw HTTP probe works (control: /health returns 200)' ($h.Status -eq 200) "status=$($h.Status)"
    $paths = @(
        '/evaluation/ground-truth/ground-truth.json',
        '/evaluation/ground-truth/',
        '/evaluation/',
        '/evaluation/migration-decisions.json',
        '/evaluation/results/ground-truth-conformance.json',
        '/ground-truth.json',
        '/ground-truth/ground-truth.json',
        '/../evaluation/ground-truth/ground-truth.json',
        '/../../evaluation/ground-truth/ground-truth.json',
        '/%2e%2e/evaluation/ground-truth/ground-truth.json',
        '/%2e%2e%2f%2e%2e%2fevaluation%2fground-truth%2fground-truth.json',
        '/..%2fevaluation%2fground-truth%2fground-truth.json',
        '/products/../../evaluation/ground-truth/ground-truth.json',
        '/index.php/../../evaluation/ground-truth/ground-truth.json',
        '/index.php?file=../../evaluation/ground-truth/ground-truth.json',
        '/....//evaluation/ground-truth/ground-truth.json',
        '/evaluation%2fground-truth%2fground-truth.json'
    )
    $leaks = New-Object System.Collections.Generic.List[string]
    $notRejected = New-Object System.Collections.Generic.List[string]
    $statuses = New-Object System.Collections.Generic.List[string]
    foreach ($p in $paths) {
        $r = Invoke-RawHttp $p
        $statuses.Add("$($r.Status)")
        if ($r.Text.Contains($prefix) -or $r.Text.Contains('expected_specification')) { $leaks.Add($p) }
        if ($r.Status -lt 400) { $notRejected.Add("$p=$($r.Status)") }
    }
    Test-Case "GI2 no probe path ($($paths.Count) incl. traversal and encoded variants) returns Ground Truth content or a canary" ($leaks.Count -eq 0) ($leaks -join ',')
    Test-Case 'GI3 every probe path is rejected with a 4xx status' ($notRejected.Count -eq 0) ("statuses=" + ($statuses -join ',') + " " + ($notRejected -join ','))

    # --- compose and mounts ---
    $composeText = Get-Content -Raw (Join-Path $script:RepoRoot 'infra/docker-compose.yml')
    Test-Case 'GI4 docker-compose.yml does not reference evaluation/ or ground-truth' (-not ($composeText -match '(?i)evaluation|ground-truth'))
    $ids = Get-ProjectContainers
    Test-Case 'GI5 the three project containers are running' ($ids.Count -eq 3) "count=$($ids.Count)"
    $mountBad = New-Object System.Collections.Generic.List[string]
    $allowedSuffix = @('/legacy/sql/schema.sql', '/legacy/sql/seed.sql', '/legacy/src', '/infra/nginx/nginx.conf')
    foreach ($id in $ids) {
        $mounts = (& docker inspect $id --format '{{json .Mounts}}') | ConvertFrom-Json
        foreach ($m in @($mounts)) {
            $src = ([string]$m.Source).Replace('\', '/')
            if ($m.Type -eq 'volume') { if ($m.Name -notmatch 'legacy-db-data$') { $mountBad.Add("$id volume $($m.Name)") }; continue }
            if ($src -match '(?i)evaluation|ground-truth' -or -not ($allowedSuffix | Where-Object { $src.EndsWith($_) })) { $mountBad.Add("$id $src -> $($m.Destination)") }
        }
    }
    Test-Case 'GI6 running containers mount only the allowed legacy files, nginx.conf and the DB volume' ($mountBad.Count -eq 0) ($mountBad -join '; ')

    # --- container file systems and DB content ---
    $byService = @{}
    foreach ($id in $ids) { $byService[(& docker inspect $id --format '{{index .Config.Labels "com.docker.compose.service"}}').Trim()] = $id }
    $ctl = Invoke-InContainer $byService['legacy-app'] "grep -rIl 'Minimum order value not met' /var/www/html 2>/dev/null | head -n 1"
    Test-Case 'GI7 in-container search works (control: a known string is found in /var/www/html)' ([bool]$ctl) $ctl
    $fsHits = New-Object System.Collections.Generic.List[string]
    foreach ($svc in 'legacy-app', 'legacy-db', 'reverse-proxy') {
        $id = $byService[$svc]
        $names = Invoke-InContainer $id "find / -xdev \( -path /proc -o -path /sys \) -prune -o \( -name 'ground-truth*' -o -name 'migration-decisions*' -o -name 'ground-truth-conformance*' \) -print 2>/dev/null"
        if ($names) { $fsHits.Add("$svc names: $names") }
        $canaryHits = Invoke-InContainer $id "grep -rIl '$prefix' /var/www /etc /tmp /home /usr/local/etc /docker-entrypoint-initdb.d 2>/dev/null | head -n 5"
        if ($canaryHits) { $fsHits.Add("$svc canary: $canaryHits") }
    }
    Test-Case 'GI8 no container holds a Ground Truth file or the canary string' ($fsHits.Count -eq 0) ($fsHits -join '; ')
    $dbId = $byService['legacy-db']
    $dumpCheck = Invoke-InContainer $dbId ('MYSQL_PWD="$MYSQL_PASSWORD" mysqldump --no-tablespaces -u"$MYSQL_USER" "$MYSQL_DATABASE" 2>/dev/null > /tmp/gi-dump.sql; echo "products=$(grep -c ''INSERT INTO `products`'' /tmp/gi-dump.sql) canary=$(grep -c ''' + $prefix + ''' /tmp/gi-dump.sql)"; rm -f /tmp/gi-dump.sql')
    Test-Case 'GI9 the legacy database contains no canary string (control: the dump contains product rows)' ($dumpCheck -match 'products=[1-9]' -and $dumpCheck -match 'canary=0') $dumpCheck
}