# Phase 2 Test Suite — legacy-sample
# Tests: T01-T21
param([string]$BASE = "http://127.0.0.1:8056")

$ProgressPreference = 'SilentlyContinue'
$pass = 0; $fail = 0

function Test-Case {
    param([string]$name, [bool]$condition, [string]$detail = "")
    if ($condition) {
        Write-Host "PASS: $name" -ForegroundColor Green
        $script:pass++
    } else {
        $msg = "FAIL: $name"
        if ($detail) { $msg += "  ($detail)" }
        Write-Host $msg -ForegroundColor Red
        $script:fail++
    }
}

function Invoke-Api {
    param([string]$method, [string]$path, $body = $null)
    $uri = "$BASE$path"
    $p = @{ Uri = $uri; Method = $method; TimeoutSec = 15; UseBasicParsing = $true; SkipHttpErrorCheck = $true }
    if ($body -ne $null) { $p.Body = ($body | ConvertTo-Json -Depth 10 -Compress); $p.ContentType = "application/json" }
    $r = Invoke-WebRequest @p
    $b = $null; try { $b = $r.Content | ConvertFrom-Json } catch {}
    return @{ status = [int]$r.StatusCode; body = $b }
}

function Do-Reset {
    $r = Invoke-Api "POST" "/reset"
    if ($r.status -ne 200) { Write-Host "  [reset failed: $($r.status)]" -ForegroundColor Yellow }
}

Write-Host "=== Phase 2 Test Suite ===" -ForegroundColor Cyan
Write-Host ""

# T01: Health check
$r = Invoke-Api "GET" "/health"
Test-Case "T01: Health check" ($r.status -eq 200 -and $r.body.data.app -eq "ok" -and $r.body.data.db -eq "ok")

# T02: Product list
Do-Reset
$r = Invoke-Api "GET" "/products"
Test-Case "T02: Product list (5 items)" ($r.status -eq 200 -and $r.body.data.Count -eq 5)

# T03: Get product (exists)
$r = Invoke-Api "GET" "/products/1"
Test-Case "T03: Get product/1 name" ($r.status -eq 200 -and $r.body.data.name -eq "Notebook A4")

# T04: Get product (not found)
$r = Invoke-Api "GET" "/products/999"
Test-Case "T04: Get product/999 -> 404" ($r.status -eq 404)

# T05: Order — discount=0, shipping=500 (subtotal=1040)
Do-Reset
$r = Invoke-Api "POST" "/orders" @{ customer_id=1; lines=@(@{product_id=2;quantity=13}) }
# 80*13=1040, discount=0, net=1040, fee=500, total=1540
Test-Case "T05: Order tier0 discount, fee=500" (
    $r.status -eq 201 -and
    $r.body.data.subtotal -eq 1040 -and
    $r.body.data.discount -eq 0 -and
    $r.body.data.shipping_fee -eq 500 -and
    $r.body.data.total -eq 1540
) "status=$($r.status) sub=$($r.body.data.subtotal) disc=$($r.body.data.discount) fee=$($r.body.data.shipping_fee) total=$($r.body.data.total)"

# T06: Order — discount=300 (subtotal=3000, boundary)
Do-Reset
$r = Invoke-Api "POST" "/orders" @{ customer_id=1; lines=@(@{product_id=1;quantity=20}) }
# 150*20=3000, discount=300, net=2700, fee=500, total=3200
Test-Case "T06: Discount tier1 boundary 3000" (
    $r.status -eq 201 -and
    $r.body.data.subtotal -eq 3000 -and
    $r.body.data.discount -eq 300 -and
    $r.body.data.shipping_fee -eq 500 -and
    $r.body.data.total -eq 3200
) "status=$($r.status) sub=$($r.body.data.subtotal) disc=$($r.body.data.discount) fee=$($r.body.data.shipping_fee) total=$($r.body.data.total)"

# T07: Order — discount=300 upper limit (subtotal=9900<=9999), net=9600>=5000 -> fee=0
Do-Reset
$r = Invoke-Api "POST" "/orders" @{ customer_id=1; lines=@(@{product_id=4;quantity=8},@{product_id=1;quantity=2}) }
# 1200*8=9600, 150*2=300 => 9900, discount=300(<=9999), net=9600, fee=0, total=9600
Test-Case "T07: Discount tier1 upper (9900), free shipping" (
    $r.status -eq 201 -and
    $r.body.data.subtotal -eq 9900 -and
    $r.body.data.discount -eq 300 -and
    $r.body.data.shipping_fee -eq 0 -and
    $r.body.data.total -eq 9600
) "status=$($r.status) sub=$($r.body.data.subtotal) disc=$($r.body.data.discount) fee=$($r.body.data.shipping_fee) total=$($r.body.data.total)"

# T08: Order — discount=1000 (subtotal=10800>=10000)
Do-Reset
$r = Invoke-Api "POST" "/orders" @{ customer_id=1; lines=@(@{product_id=4;quantity=9}) }
# 1200*9=10800, discount=1000, net=9800, fee=0, total=9800
Test-Case "T08: Discount tier2 (>=10000)" (
    $r.status -eq 201 -and
    $r.body.data.subtotal -eq 10800 -and
    $r.body.data.discount -eq 1000 -and
    $r.body.data.shipping_fee -eq 0 -and
    $r.body.data.total -eq 9800
) "status=$($r.status) sub=$($r.body.data.subtotal) disc=$($r.body.data.discount) fee=$($r.body.data.shipping_fee) total=$($r.body.data.total)"

# T09: Net_Amount>=5000 -> fee=0 (subtotal=5600, discount=300, net=5300)
Do-Reset
$r = Invoke-Api "POST" "/orders" @{ customer_id=1; lines=@(@{product_id=5;quantity=7}) }
# 800*7=5600, discount=300, net=5300, fee=0, total=5300
Test-Case "T09: Net_Amount>=5000 -> fee=0 (boundary)" (
    $r.status -eq 201 -and
    $r.body.data.subtotal -eq 5600 -and
    $r.body.data.discount -eq 300 -and
    $r.body.data.shipping_fee -eq 0 -and
    $r.body.data.total -eq 5300
) "status=$($r.status) sub=$($r.body.data.subtotal) disc=$($r.body.data.discount) fee=$($r.body.data.shipping_fee) total=$($r.body.data.total)"

# T10: Net_Amount<5000 -> fee=500 (subtotal=5200, discount=300, net=4900)
Do-Reset
$r = Invoke-Api "POST" "/orders" @{ customer_id=1; lines=@(@{product_id=4;quantity=4},@{product_id=3;quantity=2}) }
# 1200*4=4800, 200*2=400 => 5200, discount=300, net=4900, fee=500, total=5400
Test-Case "T10: Net_Amount<5000 -> fee=500" (
    $r.status -eq 201 -and
    $r.body.data.subtotal -eq 5200 -and
    $r.body.data.discount -eq 300 -and
    $r.body.data.shipping_fee -eq 500 -and
    $r.body.data.total -eq 5400
) "status=$($r.status) sub=$($r.body.data.subtotal) disc=$($r.body.data.discount) fee=$($r.body.data.shipping_fee) total=$($r.body.data.total)"

# T11: Minimum order value (960<1000)
$r = Invoke-Api "POST" "/orders" @{ customer_id=1; lines=@(@{product_id=2;quantity=12}) }
# 80*12=960 < 1000
Test-Case "T11: Below minimum order value -> 400" ($r.status -eq 400)

# T12: Insufficient stock (product_id=5, stock=50, req=51)
Do-Reset
$r = Invoke-Api "POST" "/orders" @{ customer_id=1; lines=@(@{product_id=5;quantity=51}) }
Test-Case "T12: Insufficient stock -> 409" ($r.status -eq 409)

# T13: Unknown product ID
$r = Invoke-Api "POST" "/orders" @{ customer_id=1; lines=@(@{product_id=999;quantity=1}) }
Test-Case "T13: Unknown product -> 400" ($r.status -eq 400)

# T14: Unknown customer ID
$r = Invoke-Api "POST" "/orders" @{ customer_id=999; lines=@(@{product_id=1;quantity=7}) }
Test-Case "T14: Unknown customer -> 404" ($r.status -eq 404)

# T15: Stock reservation confirmed
Do-Reset
$before = (Invoke-Api "GET" "/products/5").body.data.stock_quantity
$r = Invoke-Api "POST" "/orders" @{ customer_id=1; lines=@(@{product_id=5;quantity=3}) }
$after  = (Invoke-Api "GET" "/products/5").body.data.stock_quantity
Test-Case "T15: Stock decremented by 3 (50->47)" (
    $r.status -eq 201 -and $before -eq 50 -and $after -eq 47
) "before=$before after=$after"

# T16: Cancel — stock restored
Do-Reset
$ro = Invoke-Api "POST" "/orders" @{ customer_id=1; lines=@(@{product_id=5;quantity=3}) }
$oid = $ro.body.data.order_id
$rc = Invoke-Api "POST" "/orders/$oid/cancel"
$afterCancel = (Invoke-Api "GET" "/products/5").body.data.stock_quantity
Test-Case "T16: Cancel restores stock to 50" (
    $rc.status -eq 200 -and $afterCancel -eq 50
) "cancel_status=$($rc.status) stock_after=$afterCancel"

# T17: Double cancel
Do-Reset
$ro = Invoke-Api "POST" "/orders" @{ customer_id=1; lines=@(@{product_id=5;quantity=3}) }
$oid = $ro.body.data.order_id
Invoke-Api "POST" "/orders/$oid/cancel" | Out-Null
$rc2 = Invoke-Api "POST" "/orders/$oid/cancel"
Test-Case "T17: Double cancel -> 409" ($rc2.status -eq 409 -and $rc2.body.error -eq "Order is already cancelled")

# T18: Cancel shipped order
Do-Reset
$ro  = Invoke-Api "POST" "/orders" @{ customer_id=1; lines=@(@{product_id=5;quantity=3}) }
$oid = $ro.body.data.order_id
Invoke-Api "POST" "/test/orders/$oid/ship" | Out-Null
$rc = Invoke-Api "POST" "/orders/$oid/cancel"
Test-Case "T18: Cancel shipped -> 409" ($rc.status -eq 409 -and $rc.body.error -eq "Order cannot be cancelled")

# T19: Reset clears orders and restores stock
Do-Reset
Invoke-Api "POST" "/orders" @{ customer_id=1; lines=@(@{product_id=5;quantity=3}) } | Out-Null
Invoke-Api "POST" "/orders" @{ customer_id=2; lines=@(@{product_id=1;quantity=7}) } | Out-Null
$rr = Invoke-Api "POST" "/reset"
$orders_after = Invoke-Api "GET" "/orders"
$stock5 = (Invoke-Api "GET" "/products/5").body.data.stock_quantity
Test-Case "T19: Reset clears orders" ($orders_after.body.data.Count -eq 0) "count=$($orders_after.body.data.Count)"
Test-Case "T19b: Reset restores stock" ($stock5 -eq 50) "stock5=$stock5"

# T20: Order history
Do-Reset
$ro = Invoke-Api "POST" "/orders" @{ customer_id=2; lines=@(@{product_id=1;quantity=7}) }
$oid = $ro.body.data.order_id
$list = Invoke-Api "GET" "/orders"
$detail = Invoke-Api "GET" "/orders/$oid"
Test-Case "T20a: Order list contains 1 order" ($list.body.data.Count -eq 1 -and $list.body.data[0].customer_id -eq 2)
Test-Case "T20b: Order detail has correct line" (
    $detail.status -eq 200 -and
    $detail.body.data.lines.Count -eq 1 -and
    $detail.body.data.lines[0].product_id -eq 1 -and
    $detail.body.data.lines[0].quantity -eq 7
)

# T21: Get non-existent order
$r = Invoke-Api "GET" "/orders/99999"
Test-Case "T21: Get non-existent order -> 404" ($r.status -eq 404)

Write-Host ""
Write-Host "========================================" -ForegroundColor Cyan
$color = if ($fail -eq 0) { 'Green' } else { 'Yellow' }
Write-Host "Results: $pass passed, $fail failed" -ForegroundColor $color
Write-Host "========================================" -ForegroundColor Cyan
if ($fail -gt 0) { exit 1 } else { exit 0 }
