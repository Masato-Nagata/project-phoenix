#Requires -Version 7.0
<#
.SYNOPSIS
  Measures the lease propagation delay D and the kill-to-stop time (task 2.27). NOT a Discovery Run.
.DESCRIPTION
  REQUIRES USER CONFIRMATION OF EACH EXECUTION. It starts about 26 short-lived containers of the toolchain image, each with --network none,
  the lease directory read-only, the acknowledgement directory read-write, and the packages and node_modules read-only. It takes the
  Run-versus-Run lock (not the conformance mutex). It touches no Legacy_App, no Test API, no lab network, and no override, and it creates
  no Run_Volume, Run directory, Run_Manifest, Evidence record, or Approval_Record. It writes discovery/config/lease-timing.json and its own
  directories under discovery/leases/. The record is an observation under the recorded conditions; it does not prove a stop time for any
  other machine, Docker version, setting, or load. Build the TypeScript first (npx tsc -b in the toolchain container).
#>
[CmdletBinding()]
param()
$ErrorActionPreference = 'Stop'
$repo = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../..'))
# LeaseTiming.psm1 is imported here too: LeaseMeasure.psm1 imports it only into its own scope, so Get-LeaseSettings is not visible to this script otherwise.
Import-Module (Join-Path $PSScriptRoot 'LeaseTiming.psm1') -Force -DisableNameChecking
Import-Module (Join-Path $PSScriptRoot 'LeaseMeasure.psm1') -Force -DisableNameChecking
$r = Invoke-LeaseTimingMeasurement -RepoRoot $repo -LockPath (Join-Path $repo 'discovery/locks/discovery-run.lock') -Settings (Get-LeaseSettings) `
    -Beats 300 -HealthyTrials 10 -StoppedTrials 5 -KillTrials 10 -WriterScript (Join-Path $PSScriptRoot 'LeaseWriter.ps1')
Write-Host "result: $($r.Code)"
exit $r.ExitCode