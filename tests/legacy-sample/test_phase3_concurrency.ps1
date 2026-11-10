#Requires -Version 7.0
. (Join-Path $PSScriptRoot 'lib/common.ps1')

Invoke-TestMain {
    Write-Host '=== Phase 3: concurrent orders (no double reservation) ===' -ForegroundColor Cyan
    $base = $script:BaseUrl

    # Round 1: 12 parallel orders of 7 units against product 5 (stock 50) -> at most 7 can succeed (49 units).
    Reset-Legacy | Out-Null
    $codes = 1..12 | ForEach-Object -ThrottleLimit 12 -Parallel {
        $body = '{"customer_id":1,"lines":[{"product_id":5,"quantity":7}]}'
        $r = Invoke-WebRequest -Uri "$($using:base)/orders" -Method POST -Body $body -ContentType 'application/json' -UseBasicParsing -SkipHttpErrorCheck -TimeoutSec 60
        [int]$r.StatusCode
    }
    $ok = @($codes | Where-Object { $_ -eq 201 }).Count
    $conflict = @($codes | Where-Object { $_ -eq 409 }).Count
    $other = @($codes | Where-Object { $_ -ne 201 -and $_ -ne 409 }).Count
    Test-Case 'R1: exactly 7 of 12 parallel orders succeed' ($ok -eq 7) "201=$ok 409=$conflict other=$other"
    Test-Case 'R1: the other 5 are rejected as insufficient stock (no 5xx)' ($conflict -eq 5 -and $other -eq 0) "201=$ok 409=$conflict other=$other"
    $stock5 = (Invoke-Api -Method GET -Path '/products/5').Body.data.stock_quantity
    $reserved = [int](Invoke-Sql 'SELECT COALESCE(SUM(quantity), 0) FROM order_lines WHERE product_id = 5')
    $orderCount = [int](Invoke-Sql 'SELECT COUNT(*) FROM orders')
    Test-Case 'R1: stock is 1 and never negative' ($stock5 -eq 1) "stock=$stock5"
    Test-Case 'R1: reserved quantity (49) + remaining stock (1) equals the initial 50' ($reserved -eq 49 -and ($reserved + $stock5) -eq 50) "reserved=$reserved stock=$stock5"
    Test-Case 'R1: one stored order per successful request (7)' ($orderCount -eq 7) "orders=$orderCount"

    # Round 2: 16 parallel orders touching products 5 and 4 with the lines in opposite order (lock ordering).
    Reset-Legacy | Out-Null
    $codes2 = 1..16 | ForEach-Object -ThrottleLimit 16 -Parallel {
        if ($_ % 2 -eq 0) {
            $body = '{"customer_id":2,"lines":[{"product_id":5,"quantity":4},{"product_id":4,"quantity":2}]}'
        } else {
            $body = '{"customer_id":2,"lines":[{"product_id":4,"quantity":2},{"product_id":5,"quantity":4}]}'
        }
        $r = Invoke-WebRequest -Uri "$($using:base)/orders" -Method POST -Body $body -ContentType 'application/json' -UseBasicParsing -SkipHttpErrorCheck -TimeoutSec 60
        [int]$r.StatusCode
    }
    $ok2 = @($codes2 | Where-Object { $_ -eq 201 }).Count
    $conflict2 = @($codes2 | Where-Object { $_ -eq 409 }).Count
    $other2 = @($codes2 | Where-Object { $_ -ne 201 -and $_ -ne 409 }).Count
    Test-Case 'R2: exactly 12 of 16 parallel two-product orders succeed (50 / 4 = 12)' ($ok2 -eq 12) "201=$ok2 409=$conflict2 other=$other2"
    Test-Case 'R2: no deadlock or server error (every response is 201 or 409)' ($other2 -eq 0) "other=$other2"
    $s5 = (Invoke-Api -Method GET -Path '/products/5').Body.data.stock_quantity
    $s4 = (Invoke-Api -Method GET -Path '/products/4').Body.data.stock_quantity
    Test-Case 'R2: stock of product 5 is 2 and product 4 is 76 (all-or-nothing per order)' ($s5 -eq 2 -and $s4 -eq 76) "p5=$s5 p4=$s4"

    Reset-Legacy | Out-Null
}