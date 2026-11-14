#Requires -Version 7.0
<#
.SYNOPSIS
  Checks the M3 start gate of R21.20 (one-time M0 checkpoint exception). Read-only; writes nothing.
.DESCRIPTION
  Exit 0: allowed. Exit 2: refused, with the reason (m2_not_accepted, store_invalid, not_approved, rejected, needs_changes,
  not_human, hashes_missing, hash_mismatch, spec_missing). An approval of any other Gate does not count.
#>
[CmdletBinding()]
param()
$ErrorActionPreference = 'Stop'
$repo = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../..'))
Import-Module (Join-Path $PSScriptRoot 'MilestoneGate.psm1') -Force -DisableNameChecking
$r = Test-M3StartGate -RepoRoot $repo
Write-Host "M3 start gate: $($r.Code) ($($r.Detail)); record seq $($r.Seq)"
if ($r.Ok) { exit 0 } else { exit 2 }