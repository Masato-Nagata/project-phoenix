#Requires -Version 7.0
# The heartbeat writer of the lease timing measurement (task 2.27): renews the counter of a lease directory at the interval H with the
# Launcher's own code, until the process is killed. Used only by Measure-LeaseTiming.ps1 and its tests.
param([Parameter(Mandatory)][string]$LeaseDir, [Parameter(Mandatory)][long]$IntervalMs, [string]$DiagPath)
$ErrorActionPreference = 'Stop'
Import-Module (Join-Path $PSScriptRoot 'DiscoveryLauncher.psm1') -Force -DisableNameChecking
$counter = [long]([System.IO.File]::ReadAllText((Join-Path $LeaseDir 'heartbeat')).Trim())
$lease = [pscustomobject]@{ Dir = $LeaseDir; Counter = $counter }
$sw = [System.Diagnostics.Stopwatch]::StartNew()
$next = $sw.ElapsedMilliseconds
while ($true) {
    $next += $IntervalMs
    $wait = $next - $sw.ElapsedMilliseconds
    if ($wait -gt 0) { Start-Sleep -Milliseconds $wait }
    if (Test-Path -LiteralPath (Join-Path $LeaseDir 'revoked')) { break }
    $ws = $sw.ElapsedMilliseconds
    $v = Step-LeaseHeartbeat -Lease $lease
    # Diagnostics only: value, lateness against the schedule, write time, attempts (appended after the write; never read by any rule).
    if ($DiagPath) { $done = $sw.ElapsedMilliseconds; try { [System.IO.File]::AppendAllText($DiagPath, "$PID,$v,$([Math]::Max(0, $ws - $next)),$($done - $ws),$((Get-LastAtomicReplace).Attempts)`n") } catch { } }
}