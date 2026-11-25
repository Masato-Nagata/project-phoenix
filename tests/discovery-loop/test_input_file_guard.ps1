#Requires -Version 7.0
# InputFileGuard tests (task 4.9-C1). Real Windows file system, but ONLY in dedicated temporary directories created below the user temp
# directory; no Docker, no network, no Launcher start, nothing under the real discovery/, evaluation/, or approvals. Junctions are removed
# before the temporary directories are deleted. A test that needs a privilege the account does not have (a symbolic link) is reported as
# NOT RUN, never as PASS, and no privilege is raised and no Windows setting is changed.
. (Join-Path $PSScriptRoot 'lib/testlib.ps1')
Import-Module (Join-Path $script:ToolsDir 'InputFileGuard.psm1') -Force -DisableNameChecking
Import-Module (Join-Path $script:ToolsDir 'DiscoveryLauncher.psm1') -Force -DisableNameChecking

$utf8 = [System.Text.UTF8Encoding]::new($false)
$script:NotRun = [System.Collections.Generic.List[string]]::new()
$script:Junctions = [System.Collections.Generic.List[string]]::new()
function Set-NotRun { param([string]$Name, [string]$Reason) Write-Host "NOT RUN: $Name ($Reason)" -ForegroundColor Yellow; $script:NotRun.Add($Name) }

function New-GuardRepo {
    param([string]$Base = (New-TempDir), [string]$Name = 'repo')
    $root = Join-Path $Base $Name
    foreach ($r in (Get-InputFileTable)) {
        $p = Join-Path $root ($r.RelPath -replace '/', '\')
        [void][IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($p))
        [IO.File]::WriteAllText($p, "synthetic content for $($r.Label) CONTENT-MARKER-XYZ`n", $utf8)
    }
    $root
}
function Get-RowPath { param($Root, $Label) $tbl = Get-InputFileTable; $r = @($tbl | Where-Object { $_.Label -ceq $Label })[0]; Join-Path $Root ($r.RelPath -replace '/', '\') }
function Test-CanWrite { param([string]$Path) try { $s = [IO.File]::Open($Path, [IO.FileMode]::Open, [IO.FileAccess]::Write, [IO.FileShare]::ReadWrite); $s.Dispose(); $true } catch { $false } }
function Test-AllReleased {
    param([string]$Root)
    foreach ($r in (Get-InputFileTable)) { $p = Get-RowPath $Root $r.Label; if ((Test-Path -LiteralPath $p -PathType Leaf) -and -not (Test-CanWrite $p)) { return $false } }
    $true
}
function Test-Refused {
    param([string]$Name, $Result, [string]$Code, $Label)
    Test-Case $Name ((-not $Result.Ok) -and $null -eq $Result.Guard -and $Result.Code -ceq $Code -and ($Result.Label -ceq $Label)) "ok=$($Result.Ok) code=$($Result.Code) label=$($Result.Label)"
}
function New-Junction { param([string]$Path, [string]$Target) New-Item -ItemType Junction -Path $Path -Target $Target -ErrorAction Stop | Out-Null; $script:Junctions.Add($Path) }
function Get-Text { param([string]$Rel) [IO.File]::ReadAllText((Join-Path $script:RepoRoot $Rel)) }
function Get-CodeOnly { param([string]$Text) (($Text -split "`n") | Where-Object { $t = $_.Trim(); -not ($t.StartsWith('#') -or $t.StartsWith('//')) }) -join "`n" }

Invoke-TestMain {
    Write-Host '=== InputFileGuard (task 4.9-C1) ===' -ForegroundColor Cyan
    $table = Get-InputFileTable

    # ---------------------------------------------------------------- the table (static and parity)
    Test-Case 'table: 11 rows with unique labels, relative paths, and targets' ($table.Count -eq 11 -and @($table.Label | Select-Object -Unique).Count -eq 11 -and @($table.RelPath | Select-Object -Unique).Count -eq 11 -and @($table.Target | Select-Object -Unique).Count -eq 11)
    $expectedAll = Get-ExpectedMountTargets -Profile 'run'
    $expectedRuns = @($expectedAll | Where-Object { $_ -notin @('/run/lease', '/run/out') } | Sort-Object)
    Test-Case 'table: the targets equal the file mounts of the run profile (Get-ExpectedMountTargets minus the lease directory and the Run_Volume)' ((@($table.Target | Sort-Object) -join ',') -ceq ($expectedRuns -join ',')) ((@($table.Target | Sort-Object) -join ',') + ' vs ' + ($expectedRuns -join ','))
    # (task 4.9-C2) the arguments are built as the Launcher builds them: from the checked, held input files of a temporary repository and an image ID
    $probeRoot = New-GuardRepo
    $probeGuard = Open-InputFileGuard -RepoRoot $probeRoot -Table $table
    $createArgs = if ($probeGuard.Ok) { New-ContainerCreateArgs -Profile 'run' -RepoRoot $probeRoot -RunId 'run-20260101T000000Z-aaaaaaaaaaaa' -Nonce 'n' -PropagationDelayMs 1 -ImageId ('sha256:' + ('2' * 64)) -InputGuard $probeGuard.Guard } else { @() }
    $auditEntry = if ($probeGuard.Ok) { Get-InputFileGuardEntry -Guard $probeGuard.Guard -Label 'audit-config' } else { $null }
    if ($probeGuard.Ok) { Close-InputFileGuard -Guard $probeGuard.Guard }
    $mounts = @{}
    for ($i = 0; $i -lt $createArgs.Count - 1; $i++) {
        if ($createArgs[$i] -ceq '--mount' -and $createArgs[$i + 1] -like 'type=bind,source=*') {
            $m = $createArgs[$i + 1]; $mounts[([regex]::Match($m, 'target=([^,]+)').Groups[1].Value)] = [regex]::Match($m, 'source=([^,]+)').Groups[1].Value
        }
    }
    $sourcesOk = $true; $bad = @()
    foreach ($r in $table) {
        if ($r.Label -ceq 'audit-config') { continue }
        $want = [IO.Path]::GetFullPath((Join-Path $probeRoot ($r.RelPath -replace '/', '\')))
        if (-not $mounts.ContainsKey($r.Target) -or -not [string]::Equals([IO.Path]::GetFullPath($mounts[$r.Target]), $want, 'OrdinalIgnoreCase')) { $sourcesOk = $false; $bad += $r.Label }
    }
    Test-Case 'table: every row except the audit configuration has the same host source as the existing mount (the existing mount list is not changed)' $sourcesOk ($bad -join ',')
    $auditRow = $table | Where-Object { $_.Label -ceq 'audit-config' }
    $auditArgs = @($createArgs | Where-Object { $_ -like "type=bind,source=*,target=$($auditRow.Target),readonly" })
    Test-Case 'table: the audit row has the fixed container target /run/config/audit-config.json and the fixture source; the mount source is the checked final path of audit-config.mock.json and the mount is read-only (C2)' ($mounts.ContainsKey($auditRow.Target) -and $auditRow.Target -ceq '/run/config/audit-config.json' -and $auditRow.RelPath -ceq 'discovery/config/audit-config.mock.json' -and $null -ne $auditEntry -and [string]::Equals($mounts[$auditRow.Target], $auditEntry.MountSource, 'OrdinalIgnoreCase') -and $mounts[$auditRow.Target].EndsWith('\discovery\config\audit-config.mock.json') -and $auditArgs.Count -eq 1)
    Test-Case 'table: only the two configuration files need a hash; run-config 262144 bytes, every other file 1048576 bytes; both configs are non-empty' ((@($table | Where-Object { $_.HashRequired }).Label -join ',') -ceq 'run-config,audit-config' -and ($table | Where-Object { $_.Label -ceq 'run-config' }).MaxBytes -eq 262144 -and @($table | Where-Object { $_.Label -cne 'run-config' -and $_.MaxBytes -ne 1048576 }).Count -eq 0 -and $auditRow.MinBytes -eq 1 -and ($table | Where-Object { $_.Label -ceq 'run-config' }).MinBytes -eq 1)

    $analysisFs = Get-Text 'packages/discovery-loop/src/runtime/analysisFs.ts'
    $types = Get-Text 'packages/discovery-loop/src/schema/types.ts'
    $mainTs = Get-Text 'packages/discovery-loop/src/main.ts'
    $inputsTs = Get-Text 'packages/discovery-loop/src/runtime/startupInputs.ts'
    $auditTs = Get-Text 'packages/ai-client/src/audit/auditConfig.ts'
    $fsMax = [regex]::Match($analysisFs, 'ANALYSIS_FILE_MAX_BYTES\s*=\s*([0-9_]+)').Groups[1].Value.Replace('_', '')
    $parseMax = [regex]::Match($types, '(?s)DEFAULT_PARSE_LIMITS:\s*ParseLimits\s*=\s*Object\.freeze\(\{[^}]*?maxBytes:\s*([0-9_]+)').Groups[1].Value.Replace('_', '')
    Test-Case 'size source: the read limit of the runtime file adapter is 1048576 and the default parse limit of run-config is 262144 (read from the TypeScript sources)' ($fsMax -ceq '1048576' -and $parseMax -ceq '262144') "fs=$fsMax parse=$parseMax"
    Test-Case 'size source: run-config.json is read by the fixed-input reader (analysis file system) and parsed with DEFAULT_PARSE_LIMITS; audit-config.json is read by the same reader' ($mainTs.Contains('createFixedInputReader(paths.configDir, [RUN_CONFIG_FILE, AUDIT_CONFIG_FILE])') -and $mainTs.Contains('strictParse(runConfigRead.bytes, DEFAULT_PARSE_LIMITS)') -and $inputsTs.Contains('createAnalysisFs({ root })'))
    Test-Case 'size source: the audit-config parser limit (64 MiB) is larger than the reader limit, so the reader limit (1 MiB) is the effective bound' ($auditTs -match 'MAX_CONFIG_BYTES\s*=\s*64 \* 1024 \* 1024')
    Test-Case 'size source: the allowlist document and every allowlisted source are read through the same analysis file system (allowlist through the fixed-input reader, sources through deps.analysisFs)' ($mainTs.Contains('createFixedInputReader(paths.repoRoot, [ALLOWLIST_JSON_FILE])') -and $mainTs.Contains('analysisFs: analysisFs.value'))

    # ---------------------------------------------------------------- static checks of the module
    $guardText = [IO.File]::ReadAllText((Join-Path $script:ToolsDir 'InputFileGuard.psm1'))
    $code = Get-CodeOnly $guardText
    Test-Case 'static: the module uses the handle APIs (CreateFileW with FILE_FLAG_OPEN_REPARSE_POINT, GetFileInformationByHandle, GetFinalPathNameByHandleW, FileStreamInfo, positional reads)' ($code.Contains('CreateFileW') -and $code.Contains('0x00200000u') -and $code.Contains('GetFileInformationByHandle(') -and $code.Contains('GetFinalPathNameByHandleW') -and $code.Contains('GetFileInformationByHandleEx(h, 7') -and $code.Contains('RandomAccess.Read') -and $code.Contains('GetVolumeInformationByHandleW') -and $code.Contains('$IsWindows'))
    Test-Case 'static: no FileStream wraps the held handle (no double release), and the module starts no process, calls no Docker, writes no file' (-not ($code -match 'new\s+FileStream|FileStream\]::new|System\.IO\.FileStream') -and -not ($code -match '(?i)docker|ProcessStartInfo|Start-Process|Invoke-Expression|Out-File|Set-Content|WriteAll|AppendAll|File\]::Create|Add-Content'))
    Test-Case 'static: the NTFS gate and the single no-overwrite move are present; the only rename in the module is Move-FileNoOverwrite with overwrite false' ($code.Contains("'NTFS'") -and ([regex]::Matches($code, '\[System\.IO\.File\]::Move\(')).Count -eq 1 -and $code.Contains('[System.IO.File]::Move($Source, $Destination, $false)'))
    Test-Case 'static: the module reads no environment variable and names no evaluation, approval, override, or Ground_Truth location' (-not ($code -match '\$env:|evaluation|approvals|ground-truth|docker-compose\.discovery'))

    # ---------------------------------------------------------------- positive: the full table in a temporary repository
    $root = New-GuardRepo
    $res = Open-InputFileGuard -RepoRoot $root -Table $table
    Test-Case 'open: all 11 files are accepted in a clean temporary repository (positive control)' ($res.Ok -and $null -eq $res.Code -and $res.Guard.Entries.Count -eq 11) "code=$($res.Code) label=$($res.Label)"
    if ($res.Ok) {
        $g = $res.Guard
        $rc = Get-InputFileGuardEntry -Guard $g -Label 'run-config'; $ac = Get-InputFileGuardEntry -Guard $g -Label 'audit-config'
        $wantRc = (Get-FileHash -LiteralPath (Get-RowPath $root 'run-config') -Algorithm SHA256).Hash.ToLowerInvariant()
        $wantAc = (Get-FileHash -LiteralPath (Get-RowPath $root 'audit-config') -Algorithm SHA256).Hash.ToLowerInvariant()
        Test-Case 'open: the SHA-256 of the two configuration files equals the hash of the bytes on disk, and the other files are not hashed' ($rc.Sha256 -ceq $wantRc -and $ac.Sha256 -ceq $wantAc -and @($g.Entries | Where-Object { -not $_.HashRequired -and $null -ne $_.Sha256 }).Count -eq 0)
        Test-Case 'open: every entry has a mount source equal to its checked path, a size, and an open handle' (@($g.Entries | Where-Object { $_.Held.IsClosed -or -not [string]::Equals($_.MountSource, $_.HostPath, 'OrdinalIgnoreCase') -or $_.Size -lt 1 }).Count -eq 0)
        $p1 = Get-RowPath $root 'legacy-src-db'
        $blockedWrite = -not (Test-CanWrite $p1)
        $blockedDelete = $false; try { [IO.File]::Delete($p1) } catch { $blockedDelete = $true }
        $blockedMove = $false; try { [IO.File]::Move($p1, $p1 + '.moved') } catch { $blockedMove = $true }
        $canRead = $false; try { $canRead = ([IO.File]::ReadAllBytes($p1)).Length -gt 0 } catch { }
        Test-Case 'hold: while held, another writer, a delete, and a rename are refused, and a reader is allowed' ($blockedWrite -and $blockedDelete -and $blockedMove -and $canRead -and (Test-Path -LiteralPath $p1)) "w=$blockedWrite d=$blockedDelete m=$blockedMove r=$canRead"
        $cf = Confirm-InputFileGuard -Guard $g
        Test-Case 'confirm: the identity check passes on an unchanged held set' ($cf.Ok -and $null -eq $cf.Code) "code=$($cf.Code) label=$($cf.Label)"
        # a hard link made under the hold is either refused by the system or detected
        $linkPath = $p1 + '.link'; $linkMade = $false
        try { New-Item -ItemType HardLink -Path $linkPath -Target $p1 -ErrorAction Stop | Out-Null; $linkMade = $true } catch { }
        $cf2 = Confirm-InputFileGuard -Guard $g
        Test-Case 'confirm: a hard link made after the check is refused by the system or detected as hard_linked' ((-not $linkMade -and $cf2.Ok) -or ($linkMade -and -not $cf2.Ok -and $cf2.Code -ceq 'hard_linked' -and $cf2.Label -ceq 'legacy-src-db')) "made=$linkMade code=$($cf2.Code)"
        if ($linkMade) { try { [IO.File]::Delete($linkPath) } catch { } }
        # tampered identity data (the logic that compares the identity)
        $savedHash = $rc.Sha256; $rc.Sha256 = ('f' * 64)
        $cf3 = Confirm-InputFileGuard -Guard $g
        Test-Case 'confirm: a different recorded hash is reported as changed with the label' (-not $cf3.Ok -and $cf3.Code -ceq 'changed' -and $cf3.Label -ceq 'run-config')
        $rc.Sha256 = $savedHash
        $savedTime = $ac.LastWrite; $ac.LastWrite = $savedTime + 1
        $cf4 = Confirm-InputFileGuard -Guard $g
        Test-Case 'confirm: a different recorded write time is reported as changed' (-not $cf4.Ok -and $cf4.Code -ceq 'changed' -and $cf4.Label -ceq 'audit-config')
        $ac.LastWrite = $savedTime
        $cf5 = Confirm-InputFileGuard -Guard $g
        Test-Case 'confirm: after the tampered values are restored the check passes again' ($cf5.Ok -or ($linkMade -and $cf5.Code -ceq 'hard_linked'))
        $gi = Confirm-InputFileGuard -Guard ([pscustomobject]@{ Kind = 'other' })
        Test-Case 'confirm: an object that is not a guard is refused as guard_invalid' (-not $gi.Ok -and $gi.Code -ceq 'guard_invalid')
        Close-InputFileGuard -Guard $g
        Close-InputFileGuard -Guard $g
        Test-Case 'close: every handle is released (all files writable again), closing twice does not throw, and a closed guard is refused' ((Test-AllReleased $root) -and $g.Closed -and (Confirm-InputFileGuard -Guard $g).Code -ceq 'guard_closed')
    }

    # ---------------------------------------------------------------- bounds
    $root = New-GuardRepo
    [IO.File]::WriteAllBytes((Get-RowPath $root 'run-config'), [byte[]]::new(262144))
    [IO.File]::WriteAllBytes((Get-RowPath $root 'allowlist-md'), [byte[]]::new(1048576))
    [IO.File]::WriteAllBytes((Get-RowPath $root 'legacy-sql-seed'), [byte[]]::new(0))
    $r = Open-InputFileGuard -RepoRoot $root -Table $table
    Test-Case 'bounds: exactly 262144 bytes (run-config), exactly 1048576 bytes (other), and an empty non-config file are accepted' $r.Ok "code=$($r.Code) label=$($r.Label)"
    if ($r.Ok) { Close-InputFileGuard -Guard $r.Guard }
    $root = New-GuardRepo; [IO.File]::WriteAllBytes((Get-RowPath $root 'run-config'), [byte[]]::new(262145))
    $r = Open-InputFileGuard -RepoRoot $root -Table $table
    Test-Refused 'bounds: run-config.json of 262145 bytes is too_large' $r 'too_large' 'run-config'
    Test-Case 'bounds: after the refusal no handle is left open' (Test-AllReleased $root)
    $root = New-GuardRepo; [IO.File]::WriteAllBytes((Get-RowPath $root 'allowlist-md'), [byte[]]::new(1048577))
    Test-Refused 'bounds: a 1048577-byte allowlist document is too_large' (Open-InputFileGuard -RepoRoot $root -Table $table) 'too_large' 'allowlist-md'
    $root = New-GuardRepo; [IO.File]::WriteAllBytes((Get-RowPath $root 'run-config'), [byte[]]::new(0))
    Test-Refused 'bounds: an empty run-config.json is too_small' (Open-InputFileGuard -RepoRoot $root -Table $table) 'too_small' 'run-config'
    $root = New-GuardRepo; [IO.File]::WriteAllBytes((Get-RowPath $root 'audit-config'), [byte[]]::new(0))
    Test-Refused 'bounds: an empty audit configuration is too_small' (Open-InputFileGuard -RepoRoot $root -Table $table) 'too_small' 'audit-config'

    # ---------------------------------------------------------------- a missing file, a directory, partial failure
    $root = New-GuardRepo; [IO.File]::Delete((Get-RowPath $root 'legacy-src-db'))
    Test-Refused 'missing: a missing file is refused with its label' (Open-InputFileGuard -RepoRoot $root -Table $table) 'missing' 'legacy-src-db'
    Test-Case 'missing: the files opened before the failure are released (partial failure)' (Test-AllReleased $root)
    $root = New-GuardRepo; $mdp = Get-RowPath $root 'allowlist-md'; [IO.File]::Delete($mdp); [void][IO.Directory]::CreateDirectory($mdp)
    Test-Refused 'directory: a directory in place of a file is not_regular_file' (Open-InputFileGuard -RepoRoot $root -Table $table) 'not_regular_file' 'allowlist-md'
    $root = New-GuardRepo; [IO.Directory]::Delete((Join-Path $root 'legacy\sql'), $true)
    Test-Refused 'missing: a missing intermediate directory is a missing file' (Open-InputFileGuard -RepoRoot $root -Table $table) 'missing' 'legacy-sql-schema'

    # ---------------------------------------------------------------- hard link, alternate data stream
    $root = New-GuardRepo; $hp = Get-RowPath $root 'legacy-src-products'
    New-Item -ItemType HardLink -Path ($hp + '.other') -Target $hp | Out-Null
    Test-Refused 'hard link: a file with two names is refused as hard_linked' (Open-InputFileGuard -RepoRoot $root -Table $table) 'hard_linked' 'legacy-src-products'
    Test-Case 'hard link: after the refusal no handle is left open' (Test-AllReleased $root)
    $root = New-GuardRepo; $ap = Get-RowPath $root 'legacy-src-orders'
    Set-Content -LiteralPath $ap -Stream 'extra' -Value 'hidden'
    Test-Refused 'stream: a file with an alternate data stream is refused' (Open-InputFileGuard -RepoRoot $root -Table $table) 'alternate_stream' 'legacy-src-orders'

    # ---------------------------------------------------------------- reparse points: junctions (no privilege needed) and symbolic links (may be NOT RUN)
    $base = New-TempDir; $root = New-GuardRepo -Base $base
    $realLegacy = Join-Path $base 'real-legacy'; Move-Item -LiteralPath (Join-Path $root 'legacy') -Destination $realLegacy
    New-Junction -Path (Join-Path $root 'legacy') -Target $realLegacy
    Test-Refused 'junction: a junction as an intermediate directory is ancestor_reparse_point' (Open-InputFileGuard -RepoRoot $root -Table $table) 'ancestor_reparse_point' 'legacy-src-index'
    Test-Case 'junction: files opened before the refusal are released' (Test-AllReleased $root)
    $base = New-TempDir; $real = New-GuardRepo -Base $base -Name 'real'; $jroot = Join-Path $base 'linked'
    New-Junction -Path $jroot -Target $real
    Test-Refused 'junction: a junction AS the repository root is refused' (Open-InputFileGuard -RepoRoot $jroot -Table $table) 'ancestor_reparse_point' 'run-config'
    $base = New-TempDir; $realParent = Join-Path $base 'realparent'; $realRepo = New-GuardRepo -Base $realParent -Name 'repo'; $jparent = Join-Path $base 'linkparent'
    New-Junction -Path $jparent -Target $realParent
    Test-Refused 'junction: a junction as a PARENT of the repository root is refused' (Open-InputFileGuard -RepoRoot (Join-Path $jparent 'repo') -Table $table) 'ancestor_reparse_point' 'run-config'
    $base = New-TempDir; $root = New-GuardRepo -Base $base; $target = Join-Path $base 'target.txt'; [IO.File]::WriteAllText($target, 'x')
    $dbp = Get-RowPath $root 'legacy-src-db'; [IO.File]::Delete($dbp)
    $symMade = $false
    try { New-Item -ItemType SymbolicLink -Path $dbp -Target $target -ErrorAction Stop | Out-Null; $symMade = $true } catch { }
    if ($symMade) { Test-Refused 'symbolic link: a file that is a symbolic link is refused as reparse_point' (Open-InputFileGuard -RepoRoot $root -Table $table) 'reparse_point' 'legacy-src-db' }
    else { Set-NotRun 'symbolic link: a file that is a symbolic link is refused as reparse_point' 'the account may not create symbolic links (no privilege raised, no Windows setting changed)' }
    $base = New-TempDir; $root = New-GuardRepo -Base $base; $realSql = Join-Path $base 'real-sql'; Move-Item -LiteralPath (Join-Path $root 'legacy\sql') -Destination $realSql
    $symDirMade = $false
    try { New-Item -ItemType SymbolicLink -Path (Join-Path $root 'legacy\sql') -Target $realSql -ErrorAction Stop | Out-Null; $symDirMade = $true } catch { }
    if ($symDirMade) { Test-Refused 'symbolic link: a directory symbolic link on the way to a file is refused' (Open-InputFileGuard -RepoRoot $root -Table $table) 'ancestor_reparse_point' 'legacy-sql-schema' }
    else { Set-NotRun 'symbolic link: a directory symbolic link on the way to a file is refused' 'the account may not create symbolic links (no privilege raised, no Windows setting changed)' }

    # ---------------------------------------------------------------- root and path forms (drive letter versus other colons, UNC, device, relative)
    $good = New-GuardRepo
    $lower = $good.Substring(0, 1).ToLowerInvariant() + $good.Substring(1)
    $r = Open-InputFileGuard -RepoRoot $lower -Table $table
    Test-Case 'path: a lower-case drive letter is the same drive (the colon at index 1 is allowed; the comparison ignores case)' $r.Ok "code=$($r.Code)"
    if ($r.Ok) { Close-InputFileGuard -Guard $r.Guard }
    $badRoots = [ordered]@{
        'empty' = ''; 'relative' = 'repo\sub'; 'drive-relative' = 'C:repo'; 'forward slashes' = 'C:/repo/sub'; 'UNC' = '\\server\share\repo'
        'extended prefix' = '\\?\C:\repo\sub'; 'device prefix' = '\\.\C:\repo\sub'; 'alternate stream in the root' = 'C:\repo\sub:stream'
        'second colon' = 'C:\re:po\sub'; 'trailing backslash' = 'C:\repo\sub\'; 'dot-dot segment' = 'C:\repo\..\sub'; 'dot segment' = 'C:\repo\.\sub'
        'volume root only' = 'C:\'; 'trailing dot' = 'C:\repo\sub.'; 'trailing space' = 'C:\repo\sub '; 'wildcard' = 'C:\repo\s*b'; 'NUL' = "C:\repo\su`0b"
    }
    foreach ($k in $badRoots.Keys) {
        $rr = Open-InputFileGuard -RepoRoot $badRoots[$k] -Table $table
        Test-Case "path: root form '$k' is root_invalid and nothing is opened" (-not $rr.Ok -and $rr.Code -ceq 'root_invalid' -and $null -eq $rr.Guard -and $null -eq $rr.Label)
    }
    $row = { param($label, $rel, $target, $max = 1000, $min = 0, $hash = $false) [pscustomobject]@{ Label = $label; RelPath = $rel; Target = $target; MaxBytes = [long]$max; MinBytes = [long]$min; HashRequired = [bool]$hash } }
    $badTables = [ordered]@{
        'stream in a relative path' = @((& $row 'a' 'docs/x.txt:s' '/repo/x')); 'dot-dot segment' = @((& $row 'a' 'docs/../x.txt' '/repo/x'))
        'absolute relative path' = @((& $row 'a' '/etc/x' '/repo/x')); 'backslash' = @((& $row 'a' 'docs\x.txt' '/repo/x')); 'empty relative path' = @((& $row 'a' '' '/repo/x'))
        'duplicate label' = @((& $row 'a' 'docs/x.txt' '/repo/x'), (& $row 'a' 'docs/y.txt' '/repo/y')); 'duplicate target' = @((& $row 'a' 'docs/x.txt' '/repo/x'), (& $row 'b' 'docs/y.txt' '/repo/x'))
        'zero maximum' = @((& $row 'a' 'docs/x.txt' '/repo/x' 0)); 'maximum above 1 MiB' = @((& $row 'a' 'docs/x.txt' '/repo/x' 1048577)); 'minimum above maximum' = @((& $row 'a' 'docs/x.txt' '/repo/x' 10 11))
        'target with dot-dot' = @((& $row 'a' 'docs/x.txt' '/repo/../x')); 'relative target' = @((& $row 'a' 'docs/x.txt' 'repo/x')); 'label with a capital letter' = @((& $row 'A' 'docs/x.txt' '/repo/x'))
        'missing property' = @([pscustomobject]@{ Label = 'a'; RelPath = 'docs/x.txt' }); 'not an object' = @('docs/x.txt'); 'empty table' = @(); 'trailing dot segment' = @((& $row 'a' 'docs/x./y.txt' '/repo/x'))
    }
    foreach ($k in $badTables.Keys) {
        $rr = Open-InputFileGuard -RepoRoot $good -Table $badTables[$k]
        Test-Case "table shape: '$k' is table_invalid and nothing is opened" (-not $rr.Ok -and $rr.Code -ceq 'table_invalid' -and $null -eq $rr.Guard)
    }
    # the 8.3 short name of a directory must never be accepted (it would bypass the path equality). Two refusals are possible and both are
    # correct: .NET Path.GetFullPath expands a `~` short name to the long name, so the root text check can refuse the root (root_invalid)
    # BEFORE the final path is compared; if the expansion does not happen, the final path (the long name) differs (path_mismatch).
    $shortBase = New-TempDir; $longName = 'phoenix-long-directory-name-for-8dot3'; $longRoot = New-GuardRepo -Base $shortBase -Name $longName
    $shortRoot = $null
    try { $fso = New-Object -ComObject Scripting.FileSystemObject; $shortRoot = $fso.GetFolder($longRoot).ShortPath } catch { }
    if ($shortRoot -and $shortRoot -cne $longRoot -and $shortRoot -match '~') {
        $rr = Open-InputFileGuard -RepoRoot $shortRoot -Table $table
        Test-Case 'path: a root given by its 8.3 short name is refused (root_invalid or path_mismatch only), never accepted, and nothing is held' (-not $rr.Ok -and $null -eq $rr.Guard -and $rr.Code -cin @('root_invalid', 'path_mismatch') -and (Test-AllReleased $longRoot)) "code=$($rr.Code)"
    } else { Set-NotRun 'path: a root given by its 8.3 short name is refused (root_invalid or path_mismatch only), never accepted, and nothing is held' 'the volume has no 8.3 short names or the shell object is unavailable' }

    # ---------------------------------------------------------------- no path, no content, no exception text in a result; closed codes only
    $leakRoot = New-GuardRepo; [IO.File]::Delete((Get-RowPath $leakRoot 'legacy-src-utils'))
    $failures = @((Open-InputFileGuard -RepoRoot $leakRoot -Table $table), (Open-InputFileGuard -RepoRoot 'C:\no\such\root\x' -Table $table), (Open-InputFileGuard -RepoRoot 'bad' -Table $table))
    $json = ($failures | ForEach-Object { ConvertTo-Json -InputObject $_ -Depth 5 }) -join "`n"
    $codes = Get-InputFileGuardCodes
    Test-Case 'errors: results carry a closed code and a table label only (no path, no file content, no exception text)' (-not $json.Contains($leakRoot) -and -not $json.Contains('CONTENT-MARKER-XYZ') -and -not ($json -match '(?i)exception|stack|\\\\Users|AppData') -and @($failures | Where-Object { $_.Code -cnotin $codes }).Count -eq 0 -and @($failures | Where-Object { $null -ne $_.Label -and $_.Label -cnotin $table.Label }).Count -eq 0) $json
    Test-Case 'errors: the code vocabulary has no duplicate' (@($codes | Select-Object -Unique).Count -eq $codes.Count)

    foreach ($j in $script:Junctions) { try { if ([IO.Directory]::Exists($j)) { [IO.Directory]::Delete($j) } } catch { } }
    if ($script:NotRun.Count -gt 0) { Write-Host "NOT RUN count: $($script:NotRun.Count)" -ForegroundColor Yellow } else { Write-Host 'NOT RUN count: 0' }
}