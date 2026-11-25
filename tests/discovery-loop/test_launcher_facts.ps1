#Requires -Version 7.0
# launcher-facts.json version 2 and exclusive file creation tests (task 4.9-C1). Temporary directories only; no Docker, no network.
# The TypeScript parser is not run here (Node.js runs only in containers). The agreement with it is checked in two ways: the CONSTANTS and the
# error-code names are compared with launcherFacts.ts as text, and every code that the PowerShell checks return in a battery of bad inputs is a
# code of that TypeScript union. A behavioural comparison by running the TypeScript parser is not part of this test.
. (Join-Path $PSScriptRoot 'lib/testlib.ps1')
Import-Module (Join-Path $script:ToolsDir 'DiscoveryCommon.psm1') -Force -DisableNameChecking
Import-Module (Join-Path $script:ToolsDir 'LeaseTiming.psm1') -Force -DisableNameChecking
Import-Module (Join-Path $script:ToolsDir 'InputFileGuard.psm1') -Force -DisableNameChecking
Import-Module (Join-Path $script:ToolsDir 'DiscoveryLauncher.psm1') -Force -DisableNameChecking

$utf8 = [System.Text.UTF8Encoding]::new($false)
function Get-Text { param([string]$Rel) [IO.File]::ReadAllText((Join-Path $script:RepoRoot $Rel)) }
function Get-FileSha { param([string]$Path) (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant() }
function Get-TsList { param([string]$Text, [string]$Name) $m = [regex]::Match($Text, [regex]::Escape($Name) + '[^=]*=\s*Object\.freeze\(\[([^\]]*)\]'); if (-not $m.Success) { return $null }; @([regex]::Matches($m.Groups[1].Value, '"([^"]+)"') | ForEach-Object { $_.Groups[1].Value }) }

$run = 'run-20260101T000000Z-0123456789ab'
$img = 'sha256:' + ('a1' * 32)
$sha = 'b2' * 32
$kind = 'fixture'

Invoke-TestMain {
    Write-Host '=== launcher-facts.json v2 and exclusive creation (task 4.9-C1) ===' -ForegroundColor Cyan
    $ts = Get-Text 'packages/discovery-loop/src/runtimeFacts/launcherFacts.ts'
    $c = Get-LauncherFactsContract

    # ---------------------------------------------------------------- parity of the constants with launcherFacts.ts
    Test-Case 'parity: the six keys (as a set) equal LAUNCHER_FACTS_KEYS' ((@($c.Keys | Sort-Object) -join ',') -ceq ((Get-TsList $ts 'LAUNCHER_FACTS_KEYS' | Sort-Object) -join ',') -and $c.Keys.Count -eq 6)
    Test-Case 'parity: the kinds (as a set) equal AUDIT_CONFIG_KINDS and are exactly fixture' ((@($c.Kinds) -join ',') -ceq ((Get-TsList $ts 'AUDIT_CONFIG_KINDS') -join ',') -and $c.Kinds.Count -eq 1 -and $c.Kinds[0] -ceq 'fixture')
    $tsRun = [regex]::Match($ts, 'const RUN_ID = /(.+)/;').Groups[1].Value
    $tsImg = [regex]::Match($ts, 'const IMAGE_ID = /(.+)/;').Groups[1].Value
    $tsSha = [regex]::Match($ts, 'const SHA256_HEX = /(.+)/;').Groups[1].Value
    Test-Case 'parity: the run id, image id, and SHA-256 patterns are the TypeScript patterns (PowerShell uses \z where TypeScript uses $)' ($tsRun -ceq $c.RunIdPattern.Replace('\z', '$') -and $tsImg -ceq $c.ImageIdPattern.Replace('\z', '$') -and $tsSha -ceq $c.Sha256Pattern.Replace('\z', '$') -and $tsRun.Length -gt 10) "$tsRun | $tsImg | $tsSha"
    $tsMax = [regex]::Match($ts, 'LAUNCHER_FACTS_MAX_BYTES\s*=\s*([0-9_]+)').Groups[1].Value.Replace('_', '')
    $tsVer = [regex]::Match($ts, 'LAUNCHER_FACTS_SCHEMA_VERSION\s*=\s*([0-9]+)').Groups[1].Value
    $leaseTs = Get-Text 'packages/discovery-loop/src/runtimeFacts/leaseFacts.ts'; $adapterTs = Get-Text 'packages/discovery-loop/src/runtimeFacts/fsReadAdapters.ts'
    $leaseMax = [regex]::Match($leaseTs, 'LEASE_JSON_MAX_BYTES\s*=\s*([0-9_]+)').Groups[1].Value.Replace('_', '')
    Test-Case 'parity: 4096 bytes and schema version 2 equal the TypeScript constants, and the file adapter reads the facts file with the lease.json bound' ($tsMax -ceq '4096' -and [string]$c.MaxBytes -ceq $tsMax -and $tsVer -ceq '2' -and [string]$c.SchemaVersion -ceq $tsVer -and $leaseMax -ceq '4096' -and $adapterTs.Contains('readFixedRootFileInternal(leaseDir, [LAUNCHER_FACTS_FILE], LEASE_JSON_MAX_BYTES)'))
    Test-Case 'parity: the parser refuses the all-zero hash and image id, requires issued_by launcher, and checks the kind against AUDIT_CONFIG_KINDS' ($ts.Contains('const ZERO_SHA256 = "0".repeat(64);') -and $ts.Contains('field("issued_by") !== "launcher"') -and $ts.Contains('AUDIT_CONFIG_KINDS.includes(kind)') -and $ts.Contains('image === `sha256:${ZERO_SHA256}`'))
    $tsCodes = @([regex]::Matches([regex]::Match($ts, '(?s)export type LauncherFactsErrorCode =(.*?);').Groups[1].Value, '"([a-z0-9_]+)"') | ForEach-Object { $_.Groups[1].Value })
$needCodes = @('facts_too_large', 'facts_invalid_json', 'facts_not_object', 'field_missing', 'field_unknown', 'schema_version_invalid', 'issued_by_invalid', 'run_id_invalid', 'runtime_image_id_invalid', 'audit_config_sha256_invalid', 'audit_config_kind_invalid', 'run_id_mismatch', 'audit_config_sha256_mismatch', 'expectation_run_id_invalid', 'expectation_audit_sha256_invalid', 'facts_not_string', 'facts_read_absent')
    Test-Case 'parity: the TypeScript union has the code names that the PowerShell checks use' ($tsCodes.Count -ge 20 -and @($needCodes | Where-Object { $tsCodes -cnotcontains $_ }).Count -eq 0)

    # ---------------------------------------------------------------- generation
    $g = New-LauncherFactsText -RunId $run -RuntimeImageId $img -AuditConfigSha256 $sha -AuditConfigKind $kind
    $want = '{"audit_config_kind":"fixture","audit_config_sha256":"' + $sha + '","issued_by":"launcher","run_id":"' + $run + '","runtime_image_id":"' + $img + '","schema_version":2}'
    Test-Case 'generate: the text is the canonical JSON of exactly the six keys' ($g.Ok -and $g.Text -ceq $want) $g.Text
    Test-Case 'generate: UTF-8 without a byte-order mark, no trailing line feed, no white space, far below 4096 bytes' ($g.Bytes.Length -eq $utf8.GetByteCount($want) -and $g.Bytes.Length -lt 4096 -and -not ($g.Bytes[0] -eq 0xEF) -and $g.Bytes[$g.Bytes.Length - 1] -eq [byte][char]'}' -and $g.Text -cnotmatch '\s')
    $parsed = ConvertFrom-JsonStrict -Text $g.Text
    Test-Case 'generate: the six keys, schema_version is the integer 2' (@($parsed.Keys).Count -eq 6 -and $parsed['schema_version'] -is [long] -and $parsed['schema_version'] -eq 2 -and $parsed['issued_by'] -ceq 'launcher' -and $parsed['audit_config_kind'] -ceq 'fixture')
    $badValues = [ordered]@{
        'run id with capital letter' = @('run-20260101T000000Z-0123456789AB', $img, $sha, $kind, 'run_id_invalid')
        'run id with a trailing line feed' = @("$run`n", $img, $sha, $kind, 'run_id_invalid')
        'run id too short' = @('run-20260101T000000Z-0123456789a', $img, $sha, $kind, 'run_id_invalid')
        'run id null' = @($null, $img, $sha, $kind, 'run_id_invalid')
        'image id without prefix' = @($run, ('a1' * 32), $sha, $kind, 'runtime_image_id_invalid')
        'image id with capital hex' = @($run, ('sha256:' + ('A1' * 32)), $sha, $kind, 'runtime_image_id_invalid')
        'image id of 63 hex' = @($run, ('sha256:' + ('a' * 63)), $sha, $kind, 'runtime_image_id_invalid')
        'image id of 65 hex' = @($run, ('sha256:' + ('a' * 65)), $sha, $kind, 'runtime_image_id_invalid')
        'image id all zero' = @($run, ('sha256:' + ('0' * 64)), $sha, $kind, 'runtime_image_id_invalid')
        'image id with a trailing line feed' = @($run, "$img`n", $sha, $kind, 'runtime_image_id_invalid')
        'image id is a tag' = @($run, 'phoenix/discovery-runtime:m4', $sha, $kind, 'runtime_image_id_invalid')
        'hash all zero' = @($run, $img, ('0' * 64), $kind, 'audit_config_sha256_invalid')
        'hash with capital hex' = @($run, $img, ('B2' * 32), $kind, 'audit_config_sha256_invalid')
        'hash of 63 hex' = @($run, $img, ('b' * 63), $kind, 'audit_config_sha256_invalid')
        'hash of 65 hex' = @($run, $img, ('b' * 65), $kind, 'audit_config_sha256_invalid')
        'hash with a prefix' = @($run, $img, ('sha256:' + $sha), $kind, 'audit_config_sha256_invalid')
        'kind real' = @($run, $img, $sha, 'real', 'audit_config_kind_invalid')
        'kind with a capital letter' = @($run, $img, $sha, 'Fixture', 'audit_config_kind_invalid')
        'kind empty' = @($run, $img, $sha, '', 'audit_config_kind_invalid')
        'kind null' = @($run, $img, $sha, $null, 'audit_config_kind_invalid')
    }
    foreach ($k in $badValues.Keys) {
        $v = $badValues[$k]; $r = New-LauncherFactsText -RunId $v[0] -RuntimeImageId $v[1] -AuditConfigSha256 $v[2] -AuditConfigKind $v[3]
        Test-Case "generate: $k is refused as $($v[4]) and no text is produced" (-not $r.Ok -and $r.Code -ceq $v[4] -and $null -eq $r.Text -and $null -eq $r.Bytes) "code=$($r.Code)"
    }

    # ---------------------------------------------------------------- the checks of the text (the TypeScript parser contract)
    $ok = Test-LauncherFactsText -Text $g.Text -ExpectedRunId $run -ExpectedAuditConfigSha256 $sha
    Test-Case 'text: the generated text passes with matching expectations and returns the values' ($ok.Ok -and $ok.Values.RunId -ceq $run -and $ok.Values.RuntimeImageId -ceq $img -and $ok.Values.AuditConfigSha256 -ceq $sha -and $ok.Values.AuditConfigKind -ceq 'fixture')
    $mk = { param($drop, $extra) $o = [ordered]@{ audit_config_kind = $kind; audit_config_sha256 = $sha; issued_by = 'launcher'; run_id = $run; runtime_image_id = $img; schema_version = 2 }; foreach ($d in $drop) { $o.Remove($d) }; foreach ($k in $extra.Keys) { $o[$k] = $extra[$k] }; ($o.GetEnumerator() | ForEach-Object { '"' + $_.Key + '":' + $(if ($_.Value -is [string]) { '"' + $_.Value + '"' } else { $_.Value }) }) -join ',' }
    $json = { param($body) '{' + $body + '}' }
    $cases = [ordered]@{
        'a key is missing' = @((& $json (& $mk @('run_id') @{})), 'field_missing')
        'version 1 (five keys, no kind)' = @((& $json (& $mk @('audit_config_kind') @{ schema_version = 1 })), 'field_missing')
        'an unknown key is added' = @((& $json (& $mk @() @{ extra = '1' })), 'field_unknown')
        'a key differs only in letter case' = @((& $json ((& $mk @('run_id') @{}) + ',"Run_Id":"' + $run + '"')), 'field_missing')
        'schema_version is the string 2' = @($g.Text.Replace('"schema_version":2', '"schema_version":"2"'), 'schema_version_invalid')
        'schema_version is 3' = @($g.Text.Replace('"schema_version":2', '"schema_version":3'), 'schema_version_invalid')
        'schema_version is 2.0' = @($g.Text.Replace('"schema_version":2', '"schema_version":2.0'), 'schema_version_invalid')
        'issued_by is another value' = @((& $json (& $mk @() @{ issued_by = 'Launcher' })), 'issued_by_invalid')
        'the run id is not a run id' = @((& $json (& $mk @() @{ run_id = 'x' })), 'run_id_invalid')
        'the image id is a tag' = @((& $json (& $mk @() @{ runtime_image_id = 'phoenix/x:m4' })), 'runtime_image_id_invalid')
        'the hash is all zero' = @((& $json (& $mk @() @{ audit_config_sha256 = ('0' * 64) })), 'audit_config_sha256_invalid')
        'the kind is real' = @((& $json (& $mk @() @{ audit_config_kind = 'real' })), 'audit_config_kind_invalid')
        'a duplicate key' = @((& $json ((& $mk @() @{}) + ',"run_id":"' + $run + '"')), 'facts_invalid_json')
        'not JSON' = @('{', 'facts_invalid_json')
        'empty text' = @('', 'facts_invalid_json')
        'trailing garbage' = @(($g.Text + 'x'), 'facts_invalid_json')
        'an array' = @('[]', 'facts_not_object')
        'a string' = @('"x"', 'facts_not_object')
        'null' = @('null', 'facts_not_object')
    }
    foreach ($k in $cases.Keys) {
        $r = Test-LauncherFactsText -Text $cases[$k][0]
        Test-Case "text: $k is refused as $($cases[$k][1]), and that code is a code of the TypeScript union" (-not $r.Ok -and $r.Code -ceq $cases[$k][1] -and $tsCodes -ccontains $r.Code) "code=$($r.Code)"
    }
    Test-Case 'text: a value that is not a string is refused as facts_not_string' ((Test-LauncherFactsText -Text $null).Code -ceq 'facts_not_string' -and (Test-LauncherFactsText -Text 5).Code -ceq 'facts_not_string')
    $pad4096 = $g.Text.Substring(0, $g.Text.Length - 1) + (' ' * (4096 - $g.Text.Length)) + '}'
    Test-Case 'text: exactly 4096 bytes is within the bound, 4097 bytes is facts_too_large' ($pad4096.Length -eq 4096 -and (Test-LauncherFactsText -Text $pad4096).Ok -and (Test-LauncherFactsText -Text ($pad4096 + ' ')).Code -ceq 'facts_too_large')
    Test-Case 'text: a different run id and a different hash are run_id_mismatch and audit_config_sha256_mismatch' ((Test-LauncherFactsText -Text $g.Text -ExpectedRunId 'run-20260101T000000Z-ffffffffffff').Code -ceq 'run_id_mismatch' -and (Test-LauncherFactsText -Text $g.Text -ExpectedAuditConfigSha256 ('c3' * 32)).Code -ceq 'audit_config_sha256_mismatch')
    Test-Case 'text: a malformed expectation is refused before the text is judged' ((Test-LauncherFactsText -Text '{' -ExpectedRunId 'x').Code -ceq 'expectation_run_id_invalid' -and (Test-LauncherFactsText -Text '{' -ExpectedAuditConfigSha256 ('0' * 64)).Code -ceq 'expectation_audit_sha256_invalid')

    # ---------------------------------------------------------------- the checks of the bytes (canonical form)
    $good = $g.Bytes
    Test-Case 'bytes: the generated bytes pass with expectations' (Test-LauncherFactsBytes -Bytes $good -ExpectedRunId $run -ExpectedAuditConfigSha256 $sha).Ok
    $bytesCases = [ordered]@{
        'a byte-order mark' = @(([byte[]](0xEF, 0xBB, 0xBF) + $good), 'facts_bom')
        'a trailing line feed' = @(($good + [byte[]](10)), 'facts_not_canonical')
        'a trailing CR LF' = @(($good + [byte[]](13, 10)), 'facts_not_canonical')
        'pretty-printed JSON' = @($utf8.GetBytes(((ConvertFrom-JsonStrict -Text $g.Text) | ConvertTo-Json -Depth 3)), 'facts_not_canonical')
        'keys in another order' = @($utf8.GetBytes('{"schema_version":2,"issued_by":"launcher","run_id":"' + $run + '","runtime_image_id":"' + $img + '","audit_config_sha256":"' + $sha + '","audit_config_kind":"fixture"}'), 'facts_not_canonical')
        'bytes that are not UTF-8' = @(([byte[]]$good + [byte[]](0xFF)), 'facts_not_utf8')
        'more than 4096 bytes' = @([byte[]]::new(4097), 'facts_too_large')
        'no bytes' = @([byte[]]::new(0), 'facts_invalid_json')
        'a missing file (null)' = @($null, 'facts_read_absent')
    }
    foreach ($k in $bytesCases.Keys) {
        $r = Test-LauncherFactsBytes -Bytes $bytesCases[$k][0]
        Test-Case "bytes: $k is refused as $($bytesCases[$k][1])" (-not $r.Ok -and $r.Code -ceq $bytesCases[$k][1]) "code=$($r.Code)"
    }
    $allCodes = @($cases.Values | ForEach-Object { $_[1] }) + @($badValues.Values | ForEach-Object { $_[4] })
    $psOnly = @('facts_bom', 'facts_not_utf8', 'facts_not_canonical')
    Test-Case 'parity: the only codes that are not in the TypeScript union are the three byte-level codes of the Launcher' (@($allCodes + @($bytesCases.Values | ForEach-Object { $_[1] }) | Select-Object -Unique | Where-Object { $tsCodes -cnotcontains $_ -and $psOnly -cnotcontains $_ }).Count -eq 0 -and @($psOnly | Where-Object { $tsCodes -ccontains $_ }).Count -eq 0)

    # ---------------------------------------------------------------- Write-FileExclusive
    $dir = New-TempDir; $target = Join-Path $dir 'new.bin'; $bytes = $utf8.GetBytes('first content')
    $w = Write-FileExclusive -Path $target -Bytes $bytes
    Test-Case 'exclusive: a new file is created with exactly the bytes, reported as published, with its SHA-256, and no temporary file is left' ($w.Ok -and $w.Published -and (Test-BytesEqual ([IO.File]::ReadAllBytes($target)) $bytes) -and $w.Sha256 -ceq (Get-FileSha $target) -and -not (Test-Path -LiteralPath ($target + '.tmp')))
    $before = Get-FileSha $target
    $w2 = Write-FileExclusive -Path $target -Bytes $utf8.GetBytes('second content')
    Test-Case 'exclusive: an existing file is never overwritten (exists), is byte-identical afterwards, and no temporary file is created' (-not $w2.Ok -and $w2.Code -ceq 'exists' -and -not $w2.Published -and (Get-FileSha $target) -ceq $before -and -not (Test-Path -LiteralPath ($target + '.tmp')))
    $t2 = Join-Path $dir 'other.bin'; [IO.File]::WriteAllText($t2 + '.tmp', 'foreign temporary file')
    $w3 = Write-FileExclusive -Path $t2 -Bytes $bytes
    Test-Case 'exclusive: an existing temporary file (not ours) is refused, is not changed or removed, and no target is created' (-not $w3.Ok -and $w3.Code -ceq 'tmp_not_created' -and ([IO.File]::ReadAllText($t2 + '.tmp') -ceq 'foreign temporary file') -and -not (Test-Path -LiteralPath $t2))
    $t3 = Join-Path $dir 'adir'; [void][IO.Directory]::CreateDirectory($t3)
    Test-Case 'exclusive: a directory of that name is refused as exists' ((Write-FileExclusive -Path $t3 -Bytes $bytes).Code -ceq 'exists' -and (Test-Path -LiteralPath $t3 -PathType Container))
    Test-Case 'exclusive: a missing directory is refused as directory_invalid and nothing is created' ((Write-FileExclusive -Path (Join-Path $dir 'nodir\x.bin') -Bytes $bytes).Code -ceq 'directory_invalid' -and -not (Test-Path -LiteralPath (Join-Path $dir 'nodir')))
    $src1 = Join-Path $dir 's.tmp'; $dst1 = Join-Path $dir 'd.bin'; [IO.File]::WriteAllText($src1, 'source'); [IO.File]::WriteAllText($dst1, 'destination')
    $threw = $false; try { Move-FileNoOverwrite -Source $src1 -Destination $dst1 } catch { $threw = $true }
    Test-Case 'exclusive: the no-overwrite move throws when the destination exists, keeps the source, and does not change the destination' ($threw -and ([IO.File]::ReadAllText($src1) -ceq 'source') -and ([IO.File]::ReadAllText($dst1) -ceq 'destination'))
    $empty = Join-Path $dir 'empty.bin'
    Test-Case 'exclusive: an empty content is created as an empty file' ((Write-FileExclusive -Path $empty -Bytes ([byte[]]::new(0))).Ok -and (Get-Item -LiteralPath $empty).Length -eq 0)

    # ---------------------------------------------------------------- Write-LauncherFactsFile in a real lease directory
    $leaseRoot = New-TempDir; $leaseDir = Join-Path $leaseRoot $run
    $lease = New-RunLease -LeaseDir $leaseDir -RunId $run -Nonce ('9f' * 16) -Settings (Get-LeaseSettings)
    $leaseHash = Get-FileSha (Join-Path $leaseDir 'lease.json'); $hbHash = Get-FileSha (Join-Path $leaseDir 'heartbeat')
    $f = Write-LauncherFactsFile -LeaseDir $leaseDir -RunId $run -RuntimeImageId $img -AuditConfigSha256 $sha -AuditConfigKind $kind
    $fp = Join-Path $leaseDir 'launcher-facts.json'
    Test-Case 'facts file: written into the lease directory, byte-identical to the generated text, verified, and its SHA-256 is reported' ($f.Ok -and (Test-BytesEqual ([IO.File]::ReadAllBytes($fp)) $g.Bytes) -and $f.Sha256 -ceq (Get-FileSha $fp) -and (Test-LauncherFactsBytes -Bytes ([IO.File]::ReadAllBytes($fp)) -ExpectedRunId $run -ExpectedAuditConfigSha256 $sha).Ok)
    Test-Case 'facts file: lease.json and heartbeat are byte-identical to before (the lease contract is untouched), and no temporary file is left' ((Get-FileSha (Join-Path $leaseDir 'lease.json')) -ceq $leaseHash -and (Get-FileSha (Join-Path $leaseDir 'heartbeat')) -ceq $hbHash -and @(Get-ChildItem -LiteralPath $leaseDir -Filter '*.tmp').Count -eq 0 -and (@(Get-ChildItem -LiteralPath $leaseDir -Name | Sort-Object) -join ',') -ceq 'heartbeat,launcher-facts.json,lease.json')
    $factsHash = Get-FileSha $fp
    $f2 = Write-LauncherFactsFile -LeaseDir $leaseDir -RunId $run -RuntimeImageId ('sha256:' + ('c3' * 32)) -AuditConfigSha256 $sha -AuditConfigKind $kind
    Test-Case 'facts file: a second write is refused as exists and the first file is not changed' (-not $f2.Ok -and $f2.Code -ceq 'exists' -and (Get-FileSha $fp) -ceq $factsHash)
    $leaseDir2 = Join-Path $leaseRoot 'second'; [void][IO.Directory]::CreateDirectory($leaseDir2)
    $f3 = Write-LauncherFactsFile -LeaseDir $leaseDir2 -RunId $run -RuntimeImageId 'phoenix/discovery-runtime:m4' -AuditConfigSha256 $sha -AuditConfigKind $kind
    Test-Case 'facts file: an invalid value creates nothing (no file, no temporary file)' (-not $f3.Ok -and $f3.Code -ceq 'runtime_image_id_invalid' -and @(Get-ChildItem -LiteralPath $leaseDir2 -Force).Count -eq 0)
    $f4 = Write-LauncherFactsFile -LeaseDir (Join-Path $leaseRoot 'absent') -RunId $run -RuntimeImageId $img -AuditConfigSha256 $sha -AuditConfigKind $kind
    Test-Case 'facts file: a missing lease directory is directory_invalid and is not created' (-not $f4.Ok -and $f4.Code -ceq 'directory_invalid' -and -not (Test-Path -LiteralPath (Join-Path $leaseRoot 'absent')))
    $f5 = Write-LauncherFactsFile -LeaseDir $leaseDir2 -RunId $run -RuntimeImageId $img -AuditConfigSha256 $sha -AuditConfigKind 'real'
    Test-Case 'facts file: the kind real is refused (no kind for a real audit configuration exists)' (-not $f5.Ok -and $f5.Code -ceq 'audit_config_kind_invalid' -and @(Get-ChildItem -LiteralPath $leaseDir2 -Force).Count -eq 0)

    # ---------------------------------------------------------------- the audit hash is the hash of the bytes of the selected file (guard and facts together)
    $repo = Join-Path (New-TempDir) 'repo'
    foreach ($r in (Get-InputFileTable)) { $p = Join-Path $repo ($r.RelPath -replace '/', '\'); [void][IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($p)); [IO.File]::WriteAllText($p, "synthetic $($r.Label)`n", $utf8) }
    $auditBytes = $utf8.GetBytes('{"synthetic":"fixture bytes"}' + "`r`n" + [char]0xFEFF)
    [IO.File]::WriteAllBytes((Join-Path $repo 'discovery\config\audit-config.mock.json'), $auditBytes)
    $go = Open-InputFileGuard -RepoRoot $repo -Table (Get-InputFileTable)
    $ae = if ($go.Ok) { Get-InputFileGuardEntry -Guard $go.Guard -Label 'audit-config' } else { $null }
    $expectHash = (Get-Sha256Hex -Bytes $auditBytes)
    Test-Case 'audit hash: the SHA-256 that the guard read from the held handle equals the SHA-256 of the exact bytes (CR LF and a BOM character included) and of the file on disk' ($go.Ok -and $ae.Sha256 -ceq $expectHash -and $ae.Sha256 -ceq (Get-FileSha (Join-Path $repo 'discovery\config\audit-config.mock.json'))) "code=$($go.Code)"
    if ($go.Ok) {
        $leaseDir3 = Join-Path $leaseRoot 'third'; [void][IO.Directory]::CreateDirectory($leaseDir3)
        $f6 = Write-LauncherFactsFile -LeaseDir $leaseDir3 -RunId $run -RuntimeImageId $img -AuditConfigSha256 $ae.Sha256 -AuditConfigKind $kind
        Test-Case 'audit hash: a facts file carries that hash and passes the byte check with it as the expectation' ($f6.Ok -and (Test-LauncherFactsBytes -Bytes ([IO.File]::ReadAllBytes((Join-Path $leaseDir3 'launcher-facts.json'))) -ExpectedRunId $run -ExpectedAuditConfigSha256 $expectHash).Ok)
        Close-InputFileGuard -Guard $go.Guard
    }

    # ---------------------------------------------------------------- the existing Launcher is not changed or wired
    $launcherSrc = [IO.File]::ReadAllText((Join-Path $script:ToolsDir 'DiscoveryLauncher.psm1'))
    Test-Case 'unchanged: DiscoveryLauncher.psm1 still has exactly one [System.IO.File]::Move( (Write-TextAtomically)' ([regex]::Matches($launcherSrc, '\[System\.IO\.File\]::Move\(').Count -eq 1 -and (Get-Command Write-TextAtomically).Definition.Contains('[System.IO.File]::Move($tmp, $Path, $true)') -and (Get-Command Write-TextAtomically).Definition.Contains('FileMode]::Create'))
    $old = 'Get-LauncherConstants Invoke-DockerCli Set-DockerCliInvoker Set-LauncherTimeHooks Enter-RunLock Enter-DiscoveryLocks Exit-ConformanceMutex Exit-RunLock New-DiscoveryRunId Test-RunIdFormat Get-RunPaths Test-RunIdFree Write-TextAtomically Get-AtomicReplaceSettings Get-LastAtomicReplace Test-TransientReplaceDenial Write-ReasonFile New-LeaseNonce New-RunLease Step-LeaseHeartbeat Revoke-RunLease Stop-LeftoverRuntimeContainers Test-ContainerRunning Stop-ContainerConfirmed Set-InterruptedRuns Get-ContainerName New-ContainerCreateArgs Get-ExpectedMountTargets Get-MountInspection Test-LaunchGate Invoke-RunExport Invoke-VolumeOwnerHelper Get-VolumeKind Get-RunVolumes Write-LauncherRecord Wait-RuntimeContainer ConvertTo-FlatList Test-EvidenceSaved Remove-OwnRunContainer Invoke-DiscoveryStart'.Split(' ')
    $exported = @((Get-Module DiscoveryLauncher).ExportedFunctions.Keys)
    Test-Case 'unchanged: every previously exported function is still exported, and the new functions are added' (@($old | Where-Object { $exported -cnotcontains $_ }).Count -eq 0 -and @('Get-LauncherFactsContract', 'Test-LauncherFactsValues', 'New-LauncherFactsText', 'Test-LauncherFactsText', 'Test-LauncherFactsBytes', 'Write-FileExclusive', 'Write-LauncherFactsFile' | Where-Object { $exported -cnotcontains $_ }).Count -eq 0)
    $start = (Get-Command Invoke-DiscoveryStart).Definition
    $createDef = (Get-Command New-ContainerCreateArgs).Definition
    $tableC2 = Get-InputFileTable
    $auditRowC2 = @($tableC2 | Where-Object { $_.Label -ceq 'audit-config' })
    $targetsC2 = Get-ExpectedMountTargets -Profile 'run'
    Test-Case 'integrated (C2): Invoke-DiscoveryStart writes the facts through Write-LauncherFactsFile; neither it nor New-ContainerCreateArgs names the old host file discovery/config/audit-config.json as a mount source; the container target /run/config/audit-config.json stays (source audit-config.mock.json)' ($start.Contains('Write-LauncherFactsFile -LeaseDir') -and -not $start.Contains('discovery/config/audit-config.json') -and -not $createDef.Contains('discovery/config/audit-config.json') -and $auditRowC2.Count -eq 1 -and $auditRowC2[0].Target -ceq '/run/config/audit-config.json' -and $auditRowC2[0].RelPath -ceq 'discovery/config/audit-config.mock.json' -and @($targetsC2) -ccontains '/run/config/audit-config.json')
    $newDefs = ('Get-LauncherFactsContract', 'Test-LauncherFactsValues', 'New-LauncherFactsText', 'Test-LauncherFactsText', 'Test-LauncherFactsBytes', 'Write-FileExclusive', 'Write-LauncherFactsFile' | ForEach-Object { (Get-Command $_).Definition }) -join "`n"
    Test-Case 'static: the new functions call no Docker, start no process, and do not use Write-TextAtomically' (-not ($newDefs -match 'Invoke-DockerCli|ProcessStartInfo|Start-Process|Write-TextAtomically|PHOENIX_LEASE_NONCE|nonce'))
}