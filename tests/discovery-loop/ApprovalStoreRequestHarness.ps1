#Requires -Version 7.0
<#
.SYNOPSIS
  TEST-ONLY harness (task 2.25, design "Store-layer request interface"): sends ONE request document to Invoke-ApprovalStoreRequest.
.DESCRIPTION
  It exists to show that the modify and delete refusals are reachable through the store layer the way a real caller reaches it.
  It is not a general-purpose command, it is not used to write the real store, and nothing mounts it: it refuses a store path
  inside discovery/approvals/. The request document is a JSON object with `operation` and, for append, `candidate`.
#>
param(
    [Parameter(Mandatory)][string]$StorePath,
    [Parameter(Mandatory)][string]$RequestJsonPath
)
$ErrorActionPreference = 'Stop'
$repo = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../..'))
$real = [IO.Path]::GetFullPath((Join-Path $repo 'discovery/approvals'))
$full = [IO.Path]::GetFullPath($StorePath)
if ($full.StartsWith($real, [StringComparison]::OrdinalIgnoreCase)) { [Console]::Error.WriteLine('refused: the test harness does not write the real store'); exit 3 }
Import-Module (Join-Path $repo 'discovery/tools/ApprovalStore.psm1') -Force -DisableNameChecking
Import-Module (Join-Path $repo 'discovery/tools/DiscoveryCommon.psm1') -Force -DisableNameChecking
$request = ConvertFrom-JsonStrict -Text ([IO.File]::ReadAllText($RequestJsonPath))
$r = Invoke-ApprovalStoreRequest -StorePath $full -Request $request
foreach ($i in $r.Issues) { [Console]::Error.WriteLine("invalid field: $($i.Field) ($($i.Code))") }
Write-Output "$($r.Outcome): $($r.Message)"
exit $r.ExitCode