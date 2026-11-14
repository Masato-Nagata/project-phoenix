#Requires -Version 7.0
# OD-3 host file-system tool (task 2.20 preparation). Temporary repository roots only: no Docker, no container, no real discovery/
# directory, no conformance mutex. Running the tool here exercises it on the temporary directory; it is not the 2.20 record.
. (Join-Path $PSScriptRoot 'lib/testlib.ps1')
Import-Module (Join-Path $script:ToolsDir 'DiscoveryCommon.psm1') -Force -DisableNameChecking
Import-Module (Join-Path $script:ToolsDir 'DiscoveryLauncher.psm1') -Force -DisableNameChecking
Import-Module (Join-Path $script:ToolsDir 'FsBehavior.psm1') -Force -DisableNameChecking
$quiet = { param($m) }
function Get-FilesUnder { param([string]$Root) @(Get-ChildItem -LiteralPath $Root -Recurse -File -Force | ForEach-Object { [IO.Path]::GetRelativePath($Root, $_.FullName).Replace('\', '/') } | Sort-Object) }

Invoke-TestMain {
    Write-Host '=== OD-3 host file-system behavior tool (task 2.20 preparation) ===' -ForegroundColor Cyan
    $src = [IO.File]::ReadAllText((Join-Path $script:ToolsDir 'FsBehavior.psm1')) + [IO.File]::ReadAllText((Join-Path $script:ToolsDir 'Measure-FsBehavior.ps1'))
    Test-Case 'static: no Docker call, no container, no conformance mutex; the Run lock only' (-not ($src -match 'Invoke-DockerCli|Threading\.Mutex|Enter-DiscoveryLocks|''docker''|docker run') -and $src.Contains('Enter-RunLock'))
    Test-Case 'static: the entry point has no parameter and uses the fixed lock path' ($src.Contains('param()') -and $src.Contains("discovery/locks/discovery-run.lock"))
    $scope = Get-Od3Scope
    Test-Case 'scope: M2 items are exclusive create, Run lock, file rename, flush, directory rename; Run_Volume, ownership, mount, append, nlink are M4; the bind-mount propagation was 2.27' ((@($scope.m2) -join ',') -ceq 'exclusive_create,run_lock_exclusive,file_rename_replace,flush_to_disk,directory_rename' -and @($scope.m4).Count -eq 6 -and (@($scope.m4) -contains 'run_volume_rename') -and (@($scope.m4) -contains 'new_volume_ownership') -and @($scope.measuredBy2_27).Count -eq 2)

    # ---------------------------------------------------------------- a full run on a temporary root
    $root = New-TempDir
    $lock = Join-Path $root 'discovery/locks/discovery-run.lock'
    $r = Invoke-FsBehaviorMeasurement -RepoRoot $root -LockPath $lock -Writes 60 -FlushSamples 5 -Log $quiet
    $rec = ConvertFrom-JsonStrict -Text ([IO.File]::ReadAllText((Join-Path $root 'discovery/config/fs-behavior-od3.json')))
    $byName = @{}; foreach ($i in $rec['items']) { $byName[$i['item']] = $i }
    Test-Case 'run: exit 0 and every M2 item as expected on this host' ($r.ExitCode -eq 0 -and $rec['ok'] -eq $true -and @($rec['items']).Count -eq 5 -and @($rec['items'] | Where-Object { -not $_['ok'] }).Count -eq 0) (($rec['items'] | Where-Object { -not $_['ok'] } | ForEach-Object { $_['item'] + '=' + (ConvertTo-CanonicalJson -Value $_['observed']) }) -join ' ; ')
    Test-Case 'run: exclusive create: the second CreateNew fails with file exists; CreateDirectory on an existing directory reports no error (recorded for the export collision check)' ($byName['exclusive_create']['observed']['secondCreateNew'] -ceq 'IOException:80' -and $byName['exclusive_create']['observed']['createDirectoryOnExisting'] -ceq 'no_error')
    Test-Case 'run: file rename: every write succeeded, no partial or decreasing read under a concurrent reader' ($byName['file_rename_replace']['observed']['failedWrites'] -eq 0 -and $byName['file_rename_replace']['observed']['partialReads'] -eq 0 -and $byName['file_rename_replace']['observed']['decreasingReads'] -eq 0 -and $byName['file_rename_replace']['observed']['reads'] -gt 0)
    Test-Case 'run: directory rename: plain move keeps all files; an existing target fails with the source intact; an open file inside never leaves a half-moved directory' ($byName['directory_rename']['observed']['plainMove'] -ceq 'moved' -and $byName['directory_rename']['observed']['plainMoveFilesKept'] -eq $true -and $byName['directory_rename']['observed']['targetExists'] -cne 'moved' -and $byName['directory_rename']['observed']['targetExistsSourceKept'] -eq $true -and $byName['directory_rename']['observed']['openFileInsideConsistent'] -eq $true) (ConvertTo-CanonicalJson -Value $byName['directory_rename']['observed'])
    Test-Case 'run: the record names the file system, the host, the scope, and the fixed statement' ($rec['kind'] -ceq 'fs-behavior-od3' -and $rec['fileSystem'] -ne '' -and $rec['statement'] -like 'Observed under the recorded conditions only*' -and $null -ne $rec['scope'])
    $files = Get-FilesUnder (Join-Path $root 'discovery')
    Test-Case 'run: only the record and the lock file remain; every od3 scratch directory is removed' ((($files) -join ',') -ceq 'config/fs-behavior-od3.json,locks/discovery-run.lock' -and @(Get-ChildItem -LiteralPath (Join-Path $root 'discovery') -Recurse -Directory -Filter 'od3-*').Count -eq 0) ($files -join ',')
    $again = Enter-RunLock -LockPath $lock
    Test-Case 'run: the Run lock is released at the end' ($null -ne $again); if ($again) { $again.Dispose() }

    # ---------------------------------------------------------------- refusal and fail-closed items
    $root2 = New-TempDir; $lock2 = Join-Path $root2 'discovery/locks/discovery-run.lock'
    $held = Enter-RunLock -LockPath $lock2
    $r2 = Invoke-FsBehaviorMeasurement -RepoRoot $root2 -LockPath $lock2 -Writes 5 -FlushSamples 1 -Log $quiet
    $held.Dispose()
    Test-Case 'refusal: with the Run lock held (a Run is active) it exits 2 (run_lock) and writes nothing' ($r2.ExitCode -eq 2 -and $r2.Code -ceq 'run_lock' -and -not (Test-Path -LiteralPath (Join-Path $root2 'discovery/config')))
    $d3 = New-TempDir
    [void][IO.Directory]::CreateDirectory((Join-Path $d3 'in'))
    $neg = Measure-DirectoryRename -IncomingDir (Join-Path $d3 'in') -RunsDir (Join-Path $d3 'missing-parent/runs')
    Test-Case 'fail closed: a directory rename whose target parent does not exist is not as expected (ok false), never reported as a success' (-not $neg['ok'] -and $neg['observed']['plainMove'] -cne 'moved')
}