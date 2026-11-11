#Requires -Version 7.0
param([switch]$IncludeIsolation)
$ErrorActionPreference = 'Stop'
$scripts = @(
    'test_phase2.ps1',
    'test_phase3_boundaries.ps1',
    'test_phase3_reset.ps1',
    'test_phase3_reproducibility.ps1',
    'test_phase3_concurrency.ps1'
)
if ($IncludeIsolation) { $scripts += 'test_network_isolation.ps1' }
# Phase 4: Ground Truth, evaluation runner, reproducibility, Ground Truth isolation, AI input isolation
$scripts += @(
    'test_ground_truth_schema.ps1',
    'test_ground_truth_conformance.ps1',
    'test_ground_truth_reproducibility.ps1',
    'test_ground_truth_isolation.ps1',
    'test_ai_input_isolation.ps1'
)
$perScript = [ordered]@{}
$unverified = @()

$totalPass = 0
$totalFail = 0
$failedScripts = @()

foreach ($s in $scripts) {
    $path = Join-Path $PSScriptRoot $s
    Write-Host ''
    Write-Host ">>> $s" -ForegroundColor Cyan
    $cmd = "`$ProgressPreference = 'SilentlyContinue'; & '$path'; exit `$LASTEXITCODE"
    $lines = & pwsh -NoProfile -NonInteractive -ExecutionPolicy Bypass -Command $cmd 2>&1 | Out-String -Stream
    $code = $LASTEXITCODE
    foreach ($l in $lines) {
        if ($l -match '^(FAIL|Results)') { Write-Host $l }
        if ($l -match '^UNVERIFIED') { Write-Host $l -ForegroundColor Yellow; $unverified += "${s}: $l" }
    }
    $summary = $lines | Where-Object { $_ -match '^Results: (\d+) passed, (\d+) failed' } | Select-Object -Last 1
    if ($summary -match '^Results: (\d+) passed, (\d+) failed') {
        $totalPass += [int]$Matches[1]
        $totalFail += [int]$Matches[2]
        $perScript[$s] = "$($Matches[1]) passed, $($Matches[2]) failed"
    } else {
        Write-Host "no result line found for $s" -ForegroundColor Red
        $totalFail++
    }
    if ($code -ne 0) { $failedScripts += $s }
}

Write-Host ''
Write-Host '################ TOTAL ################' -ForegroundColor Cyan
Write-Host ("Scripts: {0}, failed scripts: {1}" -f $scripts.Count, $failedScripts.Count)
foreach ($k in $perScript.Keys) { Write-Host ("  {0,-40} {1}" -f $k, $perScript[$k]) }
Write-Host ("Total checks: {0} passed, {1} failed" -f $totalPass, $totalFail)
if ($unverified.Count -gt 0) {
    Write-Host 'Not verified (reported, not counted as passes):' -ForegroundColor Yellow
    foreach ($u in $unverified) { Write-Host "  $u" -ForegroundColor Yellow }
}
if ($failedScripts.Count -gt 0) {
    Write-Host ("Failed scripts: " + ($failedScripts -join ', ')) -ForegroundColor Red
    exit 1
}
exit 0