#Requires -Version 7.0
. (Join-Path $PSScriptRoot 'lib/common.ps1')

# Characterization only. This script records what the legacy app does with invalid
# quantities. It does NOT treat the observed behavior as the specification, never fails,
# and is not part of run_all.ps1.
function Invoke-RawOrder {
    param([string]$Json)
    $r = Invoke-WebRequest -Uri "$script:BaseUrl/orders" -Method POST -Body $Json -ContentType 'application/json' -UseBasicParsing -SkipHttpErrorCheck -TimeoutSec 30
    [pscustomobject]@{ Status = [int]$r.StatusCode; Raw = [string]$r.Content }
}

$probes = @(
    @{ Id = 'DC-001'; Label = 'quantity 0 on one line (other line valid)';          Json = '{"customer_id":1,"lines":[{"product_id":4,"quantity":10},{"product_id":1,"quantity":0}]}' },
    @{ Id = 'DC-002'; Label = 'negative quantity on one line (other line valid)';   Json = '{"customer_id":1,"lines":[{"product_id":4,"quantity":10},{"product_id":1,"quantity":-5}]}' },
    @{ Id = 'DC-003'; Label = 'non-integer quantity 1.5 (other line valid)';        Json = '{"customer_id":1,"lines":[{"product_id":4,"quantity":10},{"product_id":1,"quantity":1.5}]}' },
    @{ Id = 'DC-004'; Label = 'non-numeric quantity "abc" (other line valid)';      Json = '{"customer_id":1,"lines":[{"product_id":4,"quantity":10},{"product_id":1,"quantity":"abc"}]}' },
    @{ Id = 'DC-005'; Label = 'numeric string quantity "5" (other line valid)';     Json = '{"customer_id":1,"lines":[{"product_id":4,"quantity":10},{"product_id":1,"quantity":"5"}]}' },
    @{ Id = 'DC-006'; Label = 'quantity key missing on one line (other line valid)'; Json = '{"customer_id":1,"lines":[{"product_id":4,"quantity":10},{"product_id":1}]}' }
)

Invoke-TestMain {
    Write-Host '=== Legacy defect candidates: invalid quantity (characterization, not specification) ===' -ForegroundColor Cyan
    Write-Host 'Expected per R3.1 (positive integer quantity) and the design validation step: rejected as 400 "Invalid request". The exact code and message are a design-level expectation that the human author of the Ground Truth must confirm.'
    $mismatch = 0
    foreach ($p in $probes) {
        Reset-Legacy | Out-Null
        $stockBefore = (Invoke-Api -Method GET -Path '/products/1').Body.data.stock_quantity
        $ordersBefore = (Invoke-Api -Method GET -Path '/orders').Body.data.Count
        $r = Invoke-RawOrder $p.Json
        $stockAfter = (Invoke-Api -Method GET -Path '/products/1').Body.data.stock_quantity
        $ordersAfter = (Invoke-Api -Method GET -Path '/orders').Body.data.Count
        $rejected4xx = ($r.Status -eq 400)
        if (-not $rejected4xx) { $mismatch++ }
        $verdict = if ($rejected4xx) { 'matches expectation' } else { 'MISMATCH with expectation' }
        Write-Host ("{0}  {1}" -f $p.Id, $p.Label)
        Write-Host ("      observed : HTTP {0} {1}" -f $r.Status, $r.Raw)
        Write-Host ("      state    : orders {0}->{1}, product 1 stock {2}->{3}" -f $ordersBefore, $ordersAfter, $stockBefore, $stockAfter)
        Write-Host ("      verdict  : {0}" -f $verdict)
    }
    Reset-Legacy | Out-Null
    Write-Host ''
    Write-Host ("OBSERVED: {0} of {1} probes do not match the expectation (defect candidates, informational only)" -f $mismatch, $probes.Count) -ForegroundColor Yellow
}