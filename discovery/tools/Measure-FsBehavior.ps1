#Requires -Version 7.0
<#
.SYNOPSIS
  OD-3 host file-system behavior for task 2.20 (exclusive create, Run lock, file rename, flush, directory rename). NOT a Discovery Run.
.DESCRIPTION
  REQUIRES USER CONFIRMATION OF EACH EXECUTION. No container, no Docker command, no network. Takes the Run-versus-Run lock only;
  works in od3-<id> scratch directories under discovery/locks/, discovery/leases/, and discovery/runs/.incoming/, removes them, and
  writes discovery/config/fs-behavior-od3.json. Container-side behavior (Run_Volume, ownership, mounts) is measured in M4.
#>
[CmdletBinding()]
param()
$ErrorActionPreference = 'Stop'
$repo = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../..'))
Import-Module (Join-Path $PSScriptRoot 'FsBehavior.psm1') -Force -DisableNameChecking
$r = Invoke-FsBehaviorMeasurement -RepoRoot $repo -LockPath (Join-Path $repo 'discovery/locks/discovery-run.lock')
Write-Host "result: $($r.Code)"
exit $r.ExitCode