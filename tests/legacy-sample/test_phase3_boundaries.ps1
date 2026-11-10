#Requires -Version 7.0
. (Join-Path $PSScriptRoot 'lib/common.ps1')

Invoke-TestMain {
    Write-Host '=== Phase 3: boundary values (minimum order, discount, shipping) ===' -ForegroundColor Cyan

    Reset-Legacy | Out-Null
    Invoke-Sql "INSERT INTO products (id, name, unit_price, stock_quantity) VALUES (101, 'Test Fixture 1 yen', 1, 999999)" | Out-Null
    $fixture = Invoke-Api -Method GET -Path '/products/101'
    Test-Case 'fixture product (1 yen) is available' ($fixture.Status -eq 200 -and $fixture.Body.data.unit_price -eq 1)

    # Sub = subtotal in yen (quantity of the 1-yen fixture). Expected values are literals.
    # Net = subtotal - discount, shown in the name for the shipping boundary.
    $cases = @(
        @{ Sub =   999; Reject = $true },
        @{ Sub =  1000; Discount =    0; Fee = 500; Total = 1500 },
        @{ Sub =  1001; Discount =    0; Fee = 500; Total = 1501 },
        @{ Sub =  2999; Discount =    0; Fee = 500; Total = 3499 },
        @{ Sub =  3000; Discount =  300; Fee = 500; Total = 3200 },
        @{ Sub =  3001; Discount =  300; Fee = 500; Total = 3201 },
        @{ Sub =  4999; Discount =  300; Fee = 500; Total = 5199 },
        @{ Sub =  5000; Discount =  300; Fee = 500; Total = 5200 },
        @{ Sub =  5001; Discount =  300; Fee = 500; Total = 5201 },
        @{ Sub =  5299; Discount =  300; Fee = 500; Total = 5499; Note = 'net=4999' },
        @{ Sub =  5300; Discount =  300; Fee =   0; Total = 5000; Note = 'net=5000' },
        @{ Sub =  5301; Discount =  300; Fee =   0; Total = 5001; Note = 'net=5001' },
        @{ Sub =  9999; Discount =  300; Fee =   0; Total = 9699 },
        @{ Sub = 10000; Discount = 1000; Fee =   0; Total = 9000 },
        @{ Sub = 10001; Discount = 1000; Fee =   0; Total = 9001 }
    )

    try {
        foreach ($c in $cases) {
            $label = "subtotal=$($c.Sub)"
            if ($c.Note) { $label += " ($($c.Note))" }

            $stockBefore = (Invoke-Api -Method GET -Path '/products/101').Body.data.stock_quantity
            $ordersBefore = (Invoke-Api -Method GET -Path '/orders').Body.data.Count
            $r = Invoke-Api -Method POST -Path '/orders' -Body @{ customer_id = 1; lines = @(@{ product_id = 101; quantity = $c.Sub }) }
            $stockAfter = (Invoke-Api -Method GET -Path '/products/101').Body.data.stock_quantity
            $ordersAfter = (Invoke-Api -Method GET -Path '/orders').Body.data.Count

            if ($c.Reject) {
                Test-Case "$label -> rejected (below minimum order value)" (
                    $r.Status -eq 400 -and $r.Body.error -eq 'Minimum order value not met'
                ) "status=$($r.Status) body=$($r.Raw)"
                Test-Case "$label -> no order created and no stock change" (
                    $ordersAfter -eq $ordersBefore -and $stockAfter -eq $stockBefore
                ) "orders $ordersBefore->$ordersAfter stock $stockBefore->$stockAfter"
            } else {
                $d = $r.Body.data
                Test-Case "$label -> discount=$($c.Discount) fee=$($c.Fee) total=$($c.Total)" (
                    $r.Status -eq 201 -and
                    $d.subtotal -eq $c.Sub -and
                    $d.discount -eq $c.Discount -and
                    $d.shipping_fee -eq $c.Fee -and
                    $d.total -eq $c.Total
                ) "status=$($r.Status) body=$($r.Raw)"
                Test-Case "$label -> total = subtotal - discount + fee" (
                    $d.total -eq ($d.subtotal - $d.discount + $d.shipping_fee)
                )
                Test-Case "$label -> order created and stock reserved" (
                    $ordersAfter -eq ($ordersBefore + 1) -and $stockAfter -eq ($stockBefore - $c.Sub)
                ) "orders $ordersBefore->$ordersAfter stock $stockBefore->$stockAfter"
            }
        }
    } finally {
        Reset-Legacy | Out-Null
    }

    $gone = Invoke-Api -Method GET -Path '/products/101'
    Test-Case 'reset removes the fixture product' ($gone.Status -eq 404)
}