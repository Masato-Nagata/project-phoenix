#Requires -Version 7.0
<#
.SYNOPSIS
  Checks the M4 start gate of R21.21 (one-time M0 checkpoint exception for the start of M4 only). Read-only; writes nothing.
.DESCRIPTION
  Exit 0: allowed. Exit 2: refused, with the reason (exception_not_applicable, spec_missing, m3_not_accepted, m3_commit_not_ancestor,
  not_approved, store_invalid, rejected, needs_changes, not_human, hashes_missing, commit_missing, commit_mismatch, hash_mismatch,
  override_not_approved, override_hash_missing, override_missing, override_hash_mismatch). An approval of any other Gate does not
  count. -TargetMilestone exists only so that a use of this exception for M5 or later is refused (exception_not_applicable).
  Running this script is the M4 start gate check; it is run only when the human asks for it.
#>
[CmdletBinding()]
param([string]$TargetMilestone = 'M4')
$ErrorActionPreference = 'Stop'
$repo = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../..'))
Import-Module (Join-Path $PSScriptRoot 'MilestoneGate.psm1') -Force -DisableNameChecking
$r = Test-M4StartGate -RepoRoot $repo -TargetMilestone $TargetMilestone
Write-Host "M4 start gate: $($r.Code) ($($r.Detail)); record seq $($r.Seq)"
if ($r.Ok) { exit 0 } else { exit 2 }
