#Requires -Version 7.0
<#
.SYNOPSIS
  Discovery_Override isolation test (R18.21 to R18.28; task 4.15, written before task 2.19). Separate from, and never a replacement
  for, tests/legacy-sample/test_network_isolation.ps1.
.DESCRIPTION
  -Mode Baseline  (before 2.19, read-only Docker CLI): refuses if phoenix-discovery-lab exists; records the network membership and
                  published ports of reverse-proxy, legacy-app, and legacy-db and the hash of infra/docker-compose.yml in
                  discovery/config/lab-isolation-baseline.json. Reports NOT APPLIED as the expected state.
  -Mode Applied   (after 2.19; REQUIRES APPROVAL: it starts its own probe containers): if the network does not exist it reports
                  NOT APPLIED and exits 3. Otherwise: group A topology and group D runtime rights (configuration, docker inspect),
                  group B reachability and group C forwarding (traffic, from a probe with the runtime's network flags), group F
                  NOT MEASURED paths. Exit 0 all pass, 1 any FAIL (a failing control means the check is blind), 2 precondition.
  -Mode Restored  (after the override was removed in a separate approved step): group E; needs -LegacyTestLog, the output of
                  tests/legacy-sample/test_network_isolation.ps1 run after the removal.
  The script never applies or removes the override, never creates, removes, connects, or disconnects a network, never starts,
  stops, recreates, or execs an existing container, and never pulls an image. On a failure it changes nothing.
  -ExternalControl adds a control container on legacy-api that connects to 1.1.1.1:443 (outbound traffic; separate approval).
#>
[CmdletBinding()]
param(
    [ValidateSet('Baseline', 'Applied', 'Restored')][string]$Mode = 'Applied',
    [string]$LegacyTestLog,
    [switch]$ExternalControl
)
$ErrorActionPreference = 'Stop'
$repo = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../..'))
Import-Module (Join-Path $PSScriptRoot 'lib/labIsolation.psm1') -Force -DisableNameChecking
$log = { param($m) $color = if ($m -like 'PASS*') { 'Green' } elseif ($m -like 'FAIL*') { 'Red' } elseif ($m -like 'RESIDUAL*') { 'Magenta' } else { 'Yellow' }; Write-Host $m -ForegroundColor $color }
Write-Host "=== Discovery_Override isolation test ($Mode) ===" -ForegroundColor Cyan
$r = Invoke-LabIsolation -Mode $Mode -RepoRoot $repo -LegacyTestLog $LegacyTestLog -ExternalControl:$ExternalControl -Log $log
$fails = @($r.Checks | Where-Object { $_['status'] -eq 'FAIL' }).Count
$nm = @($r.Checks | Where-Object { $_['status'] -eq 'NOT MEASURED' }).Count
$res = @($r.Checks | Where-Object { $_['status'] -eq 'RESIDUAL' }).Count
Write-Host ''
Write-Host "Result: $($r.Code); checks $(@($r.Checks).Count), failed $fails, residual $res (not PASS; a human decides), not measured $nm$(if ($r.RecordPath) { "; record $($r.RecordPath)" })"
exit $r.ExitCode