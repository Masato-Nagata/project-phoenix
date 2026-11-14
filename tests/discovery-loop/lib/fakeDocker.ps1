# A fake Docker CLI for the Launcher and measurement tests (task 2.23). It is a scriptblock that the tests install with
# Set-DockerCliInvoker; it never starts a process and never reaches a daemon. Volumes are temporary directories.
function New-FakeDocker {
    param([Parameter(Mandatory)][string]$Root)
    $state = [hashtable]::Synchronized(@{
        Calls = [System.Collections.ArrayList]::Synchronized([System.Collections.ArrayList]::new())
        ServerVersion = '29.0.0-test'
        Images = @{ 'phoenix/discovery-toolchain:m0' = ('sha256:' + ('1' * 64)); 'phoenix/discovery-runtime:m4' = ('sha256:' + ('2' * 64)) }
        Volumes = @{}
        VolumeLabels = @{}
        FailRm = $false; IdOverride = $null
        FailOwner = $false; OwnerError = 'chown: changing ownership of ''/v'': Operation not permitted'
        Containers = @{}
        VolumeRoot = (Join-Path $Root 'fake-volumes')
        FailCopy = $false; FailVolumeRm = $false; StopFails = $false; FailVolumeCreate = $false
        ExtraMount = $null; ExtraNetwork = $null
        RunPolls = 3; ExitCodeOnEnd = '0'
        OnStart = $null
        OnRunDetached = $null
    })
    [void][IO.Directory]::CreateDirectory($state.VolumeRoot)
    $invoker = {
        param([string[]]$Arguments)
        $s = $state
        [void]$s.Calls.Add(($Arguments -join ' '))
        $ok = { param($out = '') [pscustomobject]@{ ExitCode = 0; Output = [string]$out; Error = '' } }
        $no = { param($err = 'error') [pscustomobject]@{ ExitCode = 1; Output = ''; Error = [string]$err } }
        $argAfter = { param($name) $i = [Array]::IndexOf($Arguments, $name); if ($i -ge 0 -and $i + 1 -lt $Arguments.Count) { $Arguments[$i + 1] } else { $null } }
        $key = { param($x) if ([string]$x -like 'id-*') { ([string]$x).Substring(3) } else { [string]$x } }   # a container by name or by the ID that create returned
        $allAfter = { param($name) for ($i = 0; $i -lt $Arguments.Count - 1; $i++) { if ($Arguments[$i] -eq $name) { $Arguments[$i + 1] } } }
        $parseMount = {
            param($spec)
            $m = @{}; foreach ($p in $spec.Split(',')) { $kv = $p.Split('=', 2); $m[$kv[0]] = $(if ($kv.Count -gt 1) { $kv[1] } else { $true }) }
            [ordered]@{ Type = $m['type']; Source = $m['source']; Destination = $m['target']; RW = -not $m.ContainsKey('readonly') }
        }
        switch ($Arguments[0]) {
            'version' { if (($Arguments -join ' ') -match '\|') { return (& $ok "$($s.ServerVersion)|linux|amd64|6.0-test") } else { return (& $ok $s.ServerVersion) } }
            'info' { return (& $ok 'Desktop (fake)') }
            'image' { $img = $Arguments[-1]; if ($s.Images.ContainsKey($img)) { return (& $ok $s.Images[$img]) } else { return (& $no 'no such image') } }
            'ps' {
                $filter = & $argAfter '--filter'
                $kv = $filter.Substring('label='.Length).Split('=', 2)
                $names = @($s.Containers.Keys | Where-Object { $s.Containers[$_].Labels[$kv[0]] -eq $kv[1] })
                return (& $ok ($names -join "`n"))
            }
            'volume' {
                switch ($Arguments[1]) {
                    'inspect' { if ($s.Volumes.ContainsKey($Arguments[2])) { return (& $ok '[]') } else { return (& $no 'no such volume') } }
                    'ls' {
                        $names = @($s.Volumes.Keys | Where-Object { $_ -like 'phoenix-run-*' })
                        if ($Arguments -contains '--format') { return (& $ok (($names | ForEach-Object { $l = $s.VolumeLabels[$_]; $k = if ($null -ne $l -and $l.ContainsKey('phoenix.discovery.volume-kind')) { $l['phoenix.discovery.volume-kind'] } else { '' }; "$_|$k" }) -join "`n")) }
                        return (& $ok ($names -join "`n"))
                    }
                    'create' {
                        if ($s.FailVolumeCreate) { return (& $no 'create failed') }
                        $name = $Arguments[-1]; $dir = Join-Path $s.VolumeRoot $name; [void][IO.Directory]::CreateDirectory($dir); $s.Volumes[$name] = $dir
                        $vl = @{}; foreach ($l in @(& $allAfter '--label')) { $kv = $l.Split('=', 2); $vl[$kv[0]] = $kv[1] }; $s.VolumeLabels[$name] = $vl
                        return (& $ok $name)
                    }
                    'rm' { if ($s.FailVolumeRm) { return (& $no 'volume in use') }; $name = $Arguments[2]; if ($s.Volumes.ContainsKey($name)) { Remove-Item -LiteralPath $s.Volumes[$name] -Recurse -Force; $s.Volumes.Remove($name) }; return (& $ok $name) }
                }
            }
            'run' {
                $labels = @(& $allAfter '--label')
                if ($labels -contains 'phoenix.discovery.role=volume-owner') { if ($s.FailOwner) { return [pscustomobject]@{ ExitCode = 1; Output = ''; Error = $s.OwnerError } }; return (& $ok '') }
                if ($labels -contains 'phoenix.discovery.role=export-helper') {
                    if ($s.FailCopy) { return (& $no 'copy failed') }
                    $mounts = @(& $allAfter '--mount' | ForEach-Object { & $parseMount $_ })
                    $src = ($mounts | Where-Object { $_.Destination -eq '/src' }).Source
                    $dst = ($mounts | Where-Object { $_.Destination -eq '/dst' }).Source
                    $from = $s.Volumes[$src]
                    foreach ($item in Get-ChildItem -LiteralPath $from -Force) { Copy-Item -LiteralPath $item.FullName -Destination $dst -Recurse -Force }
                    return (& $ok '')
                }
                if ($Arguments -contains '-d' -and $null -ne $s.OnRunDetached) { return (& $s.OnRunDetached $Arguments $s) }
                return (& $ok '')
            }
            'create' {
                $name = & $argAfter '--name'
                $labels = @{}; foreach ($l in @(& $allAfter '--label')) { $kv = $l.Split('=', 2); $labels[$kv[0]] = $kv[1] }
                $mounts = [System.Collections.ArrayList]::new(); foreach ($m in @(& $allAfter '--mount')) { [void]$mounts.Add((& $parseMount $m)) }
                if ($null -ne $s.ExtraMount) { [void]$mounts.Add($s.ExtraMount) }
                $networks = @(& $argAfter '--network'); if ($null -ne $s.ExtraNetwork) { $networks += $s.ExtraNetwork }
                $s.Containers[$name] = @{ Running = $false; ExitCode = '0'; Labels = $labels; Mounts = $mounts; Networks = $networks; Polls = $s.RunPolls; Env = @(& $allAfter '--env') }
                return (& $ok "id-$name")
            }
            'start' {
                $c = $s.Containers[$Arguments[1]]; if ($null -eq $c) { return (& $no 'no such container') }
                $c.Running = $true
                if ($null -ne $s.OnStart) { & $s.OnStart $Arguments[1] $s }
                return (& $ok $Arguments[1])
            }
            'inspect' {
                $name = & $key $Arguments[-1]; $c = $s.Containers[$name]
                if ($null -eq $c) { return (& $no 'Error: No such object') }
                $format = & $argAfter '--format'
                if ($format -like '{{.Id}}|*') { $lid = if ($null -ne $s.IdOverride) { $s.IdOverride } else { "id-$name" }; return (& $ok ("$lid|$($c.Labels['phoenix.discovery.run-id'])|$($c.Labels['phoenix.discovery.role'])|" + $(if ($c.Running) { 'true' } else { 'false' }))) }
                if ($format -eq '{{.State.Running}}') {
                    if ($c.Running -and $null -ne $c.Polls) { $c.Polls--; if ($c.Polls -le 0) { $c.Running = $false; $c.ExitCode = $s.ExitCodeOnEnd } }
                    return (& $ok $(if ($c.Running) { 'true' } else { 'false' }))
                }
                if ($format -eq '{{.State.ExitCode}}') { return (& $ok $c.ExitCode) }
                $mj = '[' + ((@($c.Mounts) | ForEach-Object { '{"Type":"' + $_.Type + '","Source":"' + ([string]$_.Source).Replace('\', '\\') + '","Destination":"' + $_.Destination + '","RW":' + ([string]$_.RW).ToLowerInvariant() + '}' }) -join ',') + ']'
                $nj = '{' + ((@($c.Networks) | ForEach-Object { '"' + $_ + '":{}' }) -join ',') + '}'
                return (& $ok "$mj|$nj|{}|false")
            }
            'stop' { $c = $s.Containers[$Arguments[-1]]; if ($null -ne $c -and -not $s.StopFails) { $c.Running = $false; $c.Polls = $null }; return (& $ok '') }
            'kill' { $c = $s.Containers[$Arguments[-1]]; if ($null -ne $c -and -not $s.StopFails) { $c.Running = $false; $c.Polls = $null }; return (& $ok '') }
            'rm' {
                if ($s.FailRm) { return (& $no 'Error: removal failed') }
                $n = & $key $Arguments[-1]; if (-not $s.Containers.ContainsKey($n)) { return (& $no 'Error: No such container') }
                $s.Containers.Remove($n); return (& $ok $Arguments[-1])
            }
        }
        & $no "fake: unsupported $($Arguments -join ' ')"
    }.GetNewClosure()
    [pscustomobject]@{ State = $state; Invoker = $invoker }
}

# A sealed Run directory in the record format of the Evidence_Store (records with a hash chain, one blob, and a Run_Manifest with
# the artifacts and the chain), as the PowerShell verification checks it.
function New-TestSealedRun {
    param([Parameter(Mandatory)][string]$Dir)
    [void][IO.Directory]::CreateDirectory((Join-Path $Dir 'blobs'))
    $utf8 = [System.Text.UTF8Encoding]::new($false)
    $blob = $utf8.GetBytes('{"reply":true}')
    $blobHash = Get-Sha256Hex -Bytes $blob
    [IO.File]::WriteAllBytes((Join-Path $Dir "blobs/$blobHash"), $blob)
    $prev = '0' * 64
    $sb = [System.Text.StringBuilder]::new()
    $payloads = @([ordered]@{ n = 1 }, [ordered]@{ output = [ordered]@{ blob = $blobHash; bytes = [long]$blob.Length } }, [ordered]@{ n = 2 })
    $kinds = @('run_started', 'ai_output', 'error')
    for ($i = 0; $i -lt 3; $i++) {
        $rec = [ordered]@{ id = ('rec-{0:D6}' -f ($i + 1)); kind = $kinds[$i]; payload = $payloads[$i]; prevHash = $prev; seq = [long]($i + 1) }
        $h = Get-Sha256HexOfText -Text (ConvertTo-CanonicalJson -Value $rec)
        $rec['hash'] = $h
        [void]$sb.Append((ConvertTo-CanonicalJson -Value $rec)).Append("`n")
        $prev = $h
    }
    $records = $utf8.GetBytes($sb.ToString())
    [IO.File]::WriteAllBytes((Join-Path $Dir 'records.jsonl'), $records)
    $manifest = [ordered]@{
        artifacts = @([ordered]@{ path = "blobs/$blobHash"; sha256 = $blobHash }, [ordered]@{ path = 'records.jsonl'; sha256 = (Get-Sha256Hex -Bytes $records) })
        chain = [ordered]@{ lastHash = $prev; records = [long]3 }
        runId = 'fixture'; schemaVersion = [long]1
    }
    $mb = $utf8.GetBytes((ConvertTo-CanonicalJson -Value $manifest))
    [IO.File]::WriteAllBytes((Join-Path $Dir 'manifest.json'), $mb)
    [pscustomobject]@{ ManifestSha256 = (Get-Sha256Hex -Bytes $mb); BlobHash = $blobHash }
}