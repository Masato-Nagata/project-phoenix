#Requires -Version 7.0
<#
.SYNOPSIS
  Starts one AI_Discovery_Loop Run, or the probe of task 2.20, through the Launcher (task 2.18). Host-side, PowerShell 7.
.DESCRIPTION
  REQUIRES the gates: the latest override-apply Approval_Record is approved and the store verifies; a valid lease-timing record exists
  (task 2.27); the image exists. The Launcher then takes the Run-versus-Run lock and the conformance mutex with zero wait, stops leftover
  runtime containers, marks interrupted Runs, creates the Run_Volume and the lease, creates the container, inspects its mounts, starts it,
  renews the heartbeat, stops it, revokes the lease, releases the mutex, exports the Run, and releases the Run lock.

  Scope: the exclusion holds for one host and one Windows logon session only (Local\ mutex namespace). Exclusion across logon sessions,
  users, or hosts is NOT guaranteed.

  The mutex name and the lock path are fixed constants of this script. There is no parameter, environment variable, or configuration value
  that changes them. Every use of Docker goes through Invoke-DockerCli of DiscoveryLauncher.psm1.
.PARAMETER Probe
  Starts the toolchain-image probe of task 2.20 instead of a Run (OD-12, option (a)). A probe is not a Run and is evidence for no M4 isolation requirement.
.PARAMETER AuditConfig
  Required for a Run, refused with -Probe (task 4.9-C2; decision of 2026-11-25). The only value is `fixture` (exactly, in lower case): the
  synthetic audit configuration discovery/config/audit-config.mock.json, mounted read-only at /run/config/audit-config.json. There is no
  default, no prompt, and no fallback to any other audit configuration.
#>
[CmdletBinding()]
param([switch]$Probe, [ValidateSet('fixture')][string]$AuditConfig)
$ErrorActionPreference = 'Stop'
$repo = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../..'))
Import-Module (Join-Path $PSScriptRoot 'DiscoveryLauncher.psm1') -Force -DisableNameChecking
# -AuditConfig is passed on only when it was given, so the Launcher itself refuses a missing value (no prompt, no default).
$extra = @{}
if ($PSBoundParameters.ContainsKey('AuditConfig')) { $extra['AuditConfig'] = $AuditConfig }
$result = Invoke-DiscoveryStart -RepoRoot $repo -Profile $(if ($Probe) { 'probe' } else { 'run' }) `
    -MutexName 'Local\ProjectPhoenixGroundTruthEvaluation' `
    -LockPath (Join-Path $repo 'discovery/locks/discovery-run.lock') @extra
Write-Host "result: $($result.Code)"
exit $result.ExitCode