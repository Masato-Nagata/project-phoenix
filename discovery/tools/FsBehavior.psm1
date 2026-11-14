#Requires -Version 7.0
# OD-3 file-system behavior on the host, the part needed in M2 (task 2.20; design OD-3 and the export table, steps 2 and 6).
#
# Measured here (host NTFS, the directories the Launcher itself writes): exclusive create of a file, the exclusive Run-lock handle,
# the replace of a file by rename under a concurrent reader (with the bounded retry of Write-TextAtomically), the flush-to-disk call,
# and the directory rename of the export (.incoming/<id> -> runs/<id>), including a target that exists and a source with an open file.
# NOT measured here (M4: tasks 4.11, 4.12, 4.15, 4.16, 4.19): rename and fsync inside a Run_Volume, the ownership of a new volume,
# read-only enforcement and non-root append on Docker Desktop mounts, and nlink through file mounts. The propagation of a host rename
# through the lease bind mount and the absence of partial reads were measured by task 2.27.
#
# It starts no container and calls no Docker command. It takes the Run-versus-Run lock (never the conformance mutex), works only in
# scratch directories named od3-<id> that it creates under discovery/locks/, discovery/leases/, and discovery/runs/.incoming/, removes
# them at the end, and writes one record. The record is an observation under the recorded conditions, not a guarantee.
Set-StrictMode -Version Latest
Import-Module (Join-Path $PSScriptRoot 'DiscoveryCommon.psm1') -DisableNameChecking
Import-Module (Join-Path $PSScriptRoot 'DiscoveryLauncher.psm1') -DisableNameChecking

$script:Statement = 'Observed under the recorded conditions only (this host, this file system, this load). Not a guarantee for another machine, file system, or Docker version; container-side behavior is measured in M4.'
$script:Scope = [ordered]@{
    m2 = @('exclusive_create', 'run_lock_exclusive', 'file_rename_replace', 'flush_to_disk', 'directory_rename')
    measuredBy2_27 = @('lease_bind_mount_propagation', 'lease_bind_mount_no_partial_read')
    m4 = @('run_volume_rename', 'run_volume_fsync', 'new_volume_ownership', 'mount_read_only_enforcement', 'non_root_append', 'file_mount_nlink')
}

function Get-Od3Scope { $script:Scope }

function Get-Win32Code { param($e) while ($e -is [System.Management.Automation.MethodInvocationException] -and $null -ne $e.InnerException) { $e = $e.InnerException }; [pscustomobject]@{ Type = $e.GetType().Name; Code = ($e.HResult -band 0xFFFF) } }

function New-Item0 { param($name, $expected, $observed, [bool]$ok) [ordered]@{ expected = $expected; item = $name; observed = $observed; ok = $ok } }

function Measure-ExclusiveCreate {
    param([string]$Dir)
    $f = Join-Path $Dir 'x.lock'
    $s1 = [System.IO.FileStream]::new($f, [System.IO.FileMode]::CreateNew, [System.IO.FileAccess]::Write, [System.IO.FileShare]::None); $s1.Dispose()
    $second = try { $s2 = [System.IO.FileStream]::new($f, [System.IO.FileMode]::CreateNew, [System.IO.FileAccess]::Write, [System.IO.FileShare]::None); $s2.Dispose(); 'created' } catch { $c = Get-Win32Code $_.Exception; "$($c.Type):$($c.Code)" }
    $d = Join-Path $Dir 'existing-dir'; [void][System.IO.Directory]::CreateDirectory($d)
    $dirAgain = try { [void][System.IO.Directory]::CreateDirectory($d); 'no_error' } catch { 'error' }
    New-Item0 'exclusive_create' 'second CreateNew fails with file exists (80); CreateDirectory on an existing directory reports no error, so the export collision check must be the existence test under the Run lock' ([ordered]@{ createDirectoryOnExisting = $dirAgain; secondCreateNew = $second }) ($second -eq 'IOException:80' -and $dirAgain -eq 'no_error')
}

function Measure-RunLockExclusive {
    param([string]$Dir)
    $lp = Join-Path $Dir 'run.lock'
    $a = Enter-RunLock -LockPath $lp
    $b = Enter-RunLock -LockPath $lp
    $heldRefused = ($null -ne $a -and $null -eq $b)
    if ($b) { $b.Dispose() }
    if ($a) { $a.Dispose() }
    $c = Enter-RunLock -LockPath $lp; $reopened = ($null -ne $c); if ($c) { $c.Dispose() }
    New-Item0 'run_lock_exclusive' 'a second exclusive handle is refused while the first is held; the lock can be taken again after release' ([ordered]@{ refusedWhileHeld = $heldRefused; takenAfterRelease = $reopened }) ($heldRefused -and $reopened)
}

function Measure-FileRenameReplace {
    param([string]$Dir, [int]$Writes)
    $target = Join-Path $Dir 'heartbeat'
    [System.IO.File]::WriteAllText($target, '0')
    $job = Start-ThreadJob -ScriptBlock {
        param($p, $n)
        $sw = [Diagnostics.Stopwatch]::StartNew(); $seen = [System.Collections.Generic.List[string]]::new(); $errors = 0
        while ($sw.ElapsedMilliseconds -lt 120000 -and -not (Test-Path -LiteralPath "$p.stop")) {
            try { $seen.Add([System.IO.File]::ReadAllText($p)) } catch { $errors++ }
            Start-Sleep -Milliseconds 1
        }
        [pscustomobject]@{ Seen = $seen.ToArray(); Errors = $errors }
    } -ArgumentList $target, $Writes
    $retried = 0; $failed = 0; $maxMs = 0L
    for ($i = 1; $i -le $Writes; $i++) {
        try { Write-TextAtomically -Path $target -Text ([string]$i) } catch { $failed++ }
        $l = Get-LastAtomicReplace; if ($l.Attempts -gt 1) { $retried++ }; if ($l.ElapsedMs -gt $maxMs) { $maxMs = $l.ElapsedMs }
    }
    [System.IO.File]::WriteAllText("$target.stop", '')
    $r = $job | Wait-Job -Timeout 150 | Receive-Job; $job | Remove-Job -Force
    $valid = [System.Collections.Generic.HashSet[string]]::new([string[]](0..$Writes | ForEach-Object { [string]$_ }))
    $bad = @($r.Seen | Where-Object { -not $valid.Contains($_) }).Count
    $decreasing = 0; $last = -1; foreach ($s in $r.Seen) { if ($valid.Contains($s)) { $v = [int]$s; if ($v -lt $last) { $decreasing++ }; $last = $v } }
    $final = [System.IO.File]::ReadAllText($target)
    New-Item0 'file_rename_replace' 'every write succeeds within the retry budget; every read under a concurrent reader is one complete value; values never decrease' ([ordered]@{ decreasingReads = [long]$decreasing; failedWrites = [long]$failed; finalValue = $final; maxReplaceMs = [long]$maxMs; partialReads = [long]$bad; readErrors = [long]$r.Errors; reads = [long]@($r.Seen).Count; retriedWrites = [long]$retried; writes = [long]$Writes }) ($failed -eq 0 -and $bad -eq 0 -and $decreasing -eq 0 -and $final -ceq [string]$Writes -and @($r.Seen).Count -gt 0)
}

function Measure-FlushToDisk {
    param([string]$Dir, [int]$Samples)
    $ms = [System.Collections.Generic.List[long]]::new(); $errors = 0
    $bytes = [System.Text.Encoding]::UTF8.GetBytes('x' * 64)
    for ($i = 0; $i -lt $Samples; $i++) {
        $f = Join-Path $Dir "flush-$i"
        try {
            $sw = [Diagnostics.Stopwatch]::StartNew()
            $s = [System.IO.FileStream]::new($f, [System.IO.FileMode]::CreateNew, [System.IO.FileAccess]::Write, [System.IO.FileShare]::None)
            try { $s.Write($bytes, 0, $bytes.Length); $s.Flush($true) } finally { $s.Dispose() }
            $ms.Add($sw.ElapsedMilliseconds)
        } catch { $errors++ }
    }
    $sorted = @($ms | Sort-Object)
    New-Item0 'flush_to_disk' 'Flush(true) returns without error for every sample (the call is observed; durability against power loss is not tested)' ([ordered]@{ errors = [long]$errors; maxMs = $(if ($sorted.Count) { [long]$sorted[-1] } else { [long]0 }); medianMs = $(if ($sorted.Count) { [long]$sorted[[int]($sorted.Count / 2)] } else { [long]0 }); samples = [long]$ms.Count }) ($errors -eq 0 -and $ms.Count -eq $Samples)
}

function Measure-DirectoryRename {
    param([string]$IncomingDir, [string]$RunsDir)
    $src = Join-Path $IncomingDir 'run-a'; $dst = Join-Path $RunsDir 'run-a'
    [void][System.IO.Directory]::CreateDirectory((Join-Path $src 'blobs'))
    foreach ($n in 'manifest.json', 'records.jsonl', 'COMPLETE', 'blobs/b1') { [System.IO.File]::WriteAllText((Join-Path $src $n), $n) }
    $before = @(Get-ChildItem -LiteralPath $src -Recurse -File | ForEach-Object { [System.IO.Path]::GetRelativePath($src, $_.FullName) } | Sort-Object) -join ','
    $plain = try { [System.IO.Directory]::Move($src, $dst); 'moved' } catch { $c = Get-Win32Code $_.Exception; "$($c.Type):$($c.Code)" }
    $after = if (Test-Path -LiteralPath $dst) { @(Get-ChildItem -LiteralPath $dst -Recurse -File | ForEach-Object { [System.IO.Path]::GetRelativePath($dst, $_.FullName) } | Sort-Object) -join ',' } else { '' }
    # target exists
    $src2 = Join-Path $IncomingDir 'run-b'; $dst2 = Join-Path $RunsDir 'run-b'
    [void][System.IO.Directory]::CreateDirectory($src2); [System.IO.File]::WriteAllText((Join-Path $src2 'manifest.json'), 'b'); [void][System.IO.Directory]::CreateDirectory($dst2)
    $exists = try { [System.IO.Directory]::Move($src2, $dst2); 'moved' } catch { $c = Get-Win32Code $_.Exception; "$($c.Type):$($c.Code)" }
    $srcKept2 = Test-Path -LiteralPath (Join-Path $src2 'manifest.json')
    # a file inside the source is open (for example a reader or a virus scanner)
    $src3 = Join-Path $IncomingDir 'run-c'; $dst3 = Join-Path $RunsDir 'run-c'
    [void][System.IO.Directory]::CreateDirectory($src3); [System.IO.File]::WriteAllText((Join-Path $src3 'manifest.json'), 'c')
    $h = [System.IO.File]::Open((Join-Path $src3 'manifest.json'), 'Open', 'Read', 'Read')
    $open = try { [System.IO.Directory]::Move($src3, $dst3); 'moved' } catch { $c = Get-Win32Code $_.Exception; "$($c.Type):$($c.Code)" }
    $h.Dispose()
    $src3Kept = Test-Path -LiteralPath (Join-Path $src3 'manifest.json'); $dst3Exists = Test-Path -LiteralPath $dst3
    $consistent = ($open -eq 'moved' -and -not $src3Kept -and $dst3Exists) -or ($open -ne 'moved' -and $src3Kept -and -not $dst3Exists)
    New-Item0 'directory_rename' 'a plain move keeps every file; a move onto an existing target fails and leaves the source intact; with an open file inside, the move either completes or fails with the source intact (never half-moved). The Launcher does not rely on atomicity: completion rests on the final verification (export step 7)' ([ordered]@{ openFileInside = $open; openFileInsideConsistent = $consistent; plainMove = $plain; plainMoveFilesKept = ($before -ceq $after); targetExists = $exists; targetExistsSourceKept = $srcKept2 }) ($plain -eq 'moved' -and $before -ceq $after -and $exists -ne 'moved' -and $srcKept2 -and $consistent)
}

function Invoke-FsBehaviorMeasurement {
    [CmdletBinding()]
    param([Parameter(Mandatory)][string]$RepoRoot, [Parameter(Mandatory)][string]$LockPath, [string]$RecordPath, [int]$Writes = 300, [int]$FlushSamples = 50, [scriptblock]$Log = { param($m) Write-Host $m })
    if (-not $RecordPath) { $RecordPath = Join-Path $RepoRoot 'discovery/config/fs-behavior-od3.json' }
    $lock = Enter-RunLock -LockPath $LockPath
    if ($null -eq $lock) { return [pscustomobject]@{ ExitCode = 2; Code = 'run_lock'; RecordPath = $null } }
    $b = [byte[]]::new(4); [System.Security.Cryptography.RandomNumberGenerator]::Fill($b)
    $id = 'od3-' + [DateTimeOffset]::UtcNow.ToString('yyyyMMddTHHmmssZ', [System.Globalization.CultureInfo]::InvariantCulture) + '-' + [Convert]::ToHexString($b).ToLowerInvariant()
    $dirs = [ordered]@{
        locks = Join-Path $RepoRoot "discovery/locks/$id"; leases = Join-Path $RepoRoot "discovery/leases/$id"
        incoming = Join-Path $RepoRoot "discovery/runs/.incoming/$id"; runs = Join-Path $RepoRoot "discovery/runs/.incoming/$id-final"
    }
    $created = [System.Collections.Generic.List[string]]::new()
    try {
        foreach ($d in $dirs.Values) { if (Test-Path -LiteralPath $d) { throw "scratch directory exists: $d" }; [void][System.IO.Directory]::CreateDirectory($d); $created.Add($d) }
        $items = [System.Collections.Generic.List[object]]::new()
        foreach ($step in @(
                { Measure-ExclusiveCreate -Dir $dirs.locks }, { Measure-RunLockExclusive -Dir $dirs.locks },
                { Measure-FileRenameReplace -Dir $dirs.leases -Writes $Writes }, { Measure-FlushToDisk -Dir $dirs.leases -Samples $FlushSamples },
                { Measure-DirectoryRename -IncomingDir $dirs.incoming -RunsDir $dirs.runs })) {
            try { $items.Add((& $step)) } catch { $items.Add((New-Item0 'error' 'no exception' ([ordered]@{ message = $_.Exception.Message }) $false)) }
        }
        $drive = try { [System.IO.DriveInfo]::new([System.IO.Path]::GetPathRoot([System.IO.Path]::GetFullPath($RepoRoot))) } catch { $null }
        $ok = @($items | Where-Object { -not $_['ok'] }).Count -eq 0
        $record = [ordered]@{
            fileSystem = $(if ($drive) { [string]$drive.DriveFormat } else { '' }); host = [string][System.Environment]::OSVersion.VersionString
            items = $items.ToArray(); kind = 'fs-behavior-od3'; measuredAt = [DateTimeOffset]::Now.ToString("yyyy-MM-dd'T'HH:mm:ss.fffzzz", [System.Globalization.CultureInfo]::InvariantCulture)
            measureId = $id; ok = $ok; schemaVersion = [long]1; scope = $script:Scope; statement = $script:Statement
        }
        $rd = Split-Path -Parent $RecordPath; if (-not (Test-Path -LiteralPath $rd)) { [void][System.IO.Directory]::CreateDirectory($rd) }
        Write-TextAtomically -Path $RecordPath -Text ((ConvertTo-CanonicalJson -Value $record) + "`n")
        foreach ($it in $items) { & $Log ("{0}: {1}" -f $it['item'], $(if ($it['ok']) { 'as expected' } else { 'NOT as expected' })) }
        [pscustomobject]@{ ExitCode = $(if ($ok) { 0 } else { 1 }); Code = $(if ($ok) { 'observed' } else { 'unexpected_behavior' }); RecordPath = $RecordPath; MeasureId = $id }
    } finally {
        foreach ($d in $created) { try { if (Test-Path -LiteralPath $d) { Remove-Item -LiteralPath $d -Recurse -Force } } catch { } }
        $lock.Dispose()
    }
}

Export-ModuleMember -Function Get-Od3Scope, Measure-ExclusiveCreate, Measure-RunLockExclusive, Measure-FileRenameReplace, Measure-FlushToDisk, Measure-DirectoryRename, Invoke-FsBehaviorMeasurement