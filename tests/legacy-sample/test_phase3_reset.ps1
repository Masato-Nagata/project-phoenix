#Requires -Version 7.0
. (Join-Path $PSScriptRoot 'lib/common.ps1')

function Test-ProductsMatchSeed {
    param($ApiProducts, $Seed)
    if (@($ApiProducts).Count -ne @($Seed).Count) { return $false }
    foreach ($s in $Seed) {
        $p = @($ApiProducts | Where-Object { $_.id -eq $s.id })
        if ($p.Count -ne 1) { return $false }
        if ($p[0].name -ne $s.name -or $p[0].unit_price -ne $s.unit_price -or $p[0].stock_quantity -ne $s.stock_quantity) { return $false }
    }
    $true
}

function Get-StateSnapshot {
    $sql = @(
        "SELECT 'orders', COUNT(*) FROM orders;",
        "SELECT 'order_lines', COUNT(*) FROM order_lines;",
        "SELECT 'products', id, name, unit_price, stock_quantity FROM products ORDER BY id;",
        "SELECT 'customers', id, name FROM customers ORDER BY id;",
        "SELECT 'autoinc', table_name, auto_increment FROM information_schema.tables WHERE table_schema = DATABASE() AND table_name IN ('orders','order_lines') ORDER BY table_name;"
    ) -join "`n"
    Invoke-Sql $sql
}

Invoke-TestMain {
    Write-Host '=== Phase 3: reset ===' -ForegroundColor Cyan
    $seed = Read-SeedSql
    Test-Case 'seed.sql parsed (5 products, 3 customers)' ($seed.Products.Count -eq 5 -and $seed.Customers.Count -eq 3)

    Reset-Legacy | Out-Null
    $api = (Invoke-Api -Method GET -Path '/products').Body.data
    Test-Case 'A1: GET /products equals seed.sql (id, name, unit_price, stock_quantity)' (Test-ProductsMatchSeed $api $seed.Products)
    $custRows = (Invoke-Sql 'SELECT id, name FROM customers ORDER BY id') -split "`n"
    $expectedCust = @($seed.Customers | ForEach-Object { "$($_.id)`t$($_.name)" })
    Test-Case 'A2: customers table equals seed.sql' (($custRows -join '|') -eq ($expectedCust -join '|'))
    foreach ($s in $seed.Products) {
        $one = Invoke-Api -Method GET -Path "/products/$($s.id)"
        Test-Case "A3: GET /products/$($s.id) returns seed fields" (
            $one.Status -eq 200 -and $one.Body.data.name -eq $s.name -and
            $one.Body.data.unit_price -eq $s.unit_price -and $one.Body.data.stock_quantity -eq $s.stock_quantity
        )
    }

    $o1 = Invoke-Api -Method POST -Path '/orders' -Body @{ customer_id = 1; lines = @(@{ product_id = 1; quantity = 20 }) }
    $o2 = Invoke-Api -Method POST -Path '/orders' -Body @{ customer_id = 2; lines = @(@{ product_id = 4; quantity = 9 }) }
    $o3 = Invoke-Api -Method POST -Path '/orders' -Body @{ customer_id = 3; lines = @(@{ product_id = 5; quantity = 7 }, @{ product_id = 3; quantity = 4 }) }
    Invoke-Api -Method POST -Path "/orders/$($o1.Body.data.order_id)/cancel" | Out-Null
    Invoke-Api -Method POST -Path "/test/orders/$($o2.Body.data.order_id)/ship" | Out-Null
    $dirty = @(
        "INSERT INTO products (id, name, unit_price, stock_quantity) VALUES (101, 'Test Fixture', 1, 10);",
        "INSERT INTO customers (id, name) VALUES (99, 'Test Customer');",
        "UPDATE products SET name = 'changed', unit_price = 1, stock_quantity = 7 WHERE id = 2;",
        "UPDATE customers SET name = 'changed' WHERE id = 1;"
    ) -join "`n"
    Invoke-Sql $dirty | Out-Null
    $preOrders = [int](Invoke-Sql 'SELECT COUNT(*) FROM orders')
    $preLines = [int](Invoke-Sql 'SELECT COUNT(*) FROM order_lines')
    Test-Case 'B0: dirty state prepared (3 orders, 4 lines, extra rows, edited rows)' ($preOrders -eq 3 -and $preLines -eq 4)

    $rst = Invoke-Api -Method POST -Path '/reset'
    Test-Case 'B1: reset returns 200 success' ($rst.Status -eq 200 -and $rst.Body.success -eq $true) $rst.Raw
    Test-Case 'B2: reset reports the real deleted counts' (
        $rst.Body.data.orders_deleted -eq $preOrders -and $rst.Body.data.order_lines_deleted -eq $preLines -and $rst.Body.data.products_restored -eq 5
    ) $rst.Raw
    Test-Case 'B3: order history is empty' ((Invoke-Api -Method GET -Path '/orders').Body.data.Count -eq 0)
    Test-Case 'B4: products equal seed.sql again (edited row restored)' (Test-ProductsMatchSeed (Invoke-Api -Method GET -Path '/products').Body.data $seed.Products)
    Test-Case 'B5: extra product removed' ((Invoke-Api -Method GET -Path '/products/101').Status -eq 404 -and [int](Invoke-Sql 'SELECT COUNT(*) FROM products WHERE id = 101') -eq 0)
    $custRows = (Invoke-Sql 'SELECT id, name FROM customers ORDER BY id') -split "`n"
    Test-Case 'B6: extra customer removed and edited customer restored' (($custRows -join '|') -eq ($expectedCust -join '|'))
    Test-Case 'B7: orders and order_lines tables are empty' (
        [int](Invoke-Sql 'SELECT COUNT(*) FROM orders') -eq 0 -and [int](Invoke-Sql 'SELECT COUNT(*) FROM order_lines') -eq 0
    )

    $ai = (Invoke-Sql "SELECT table_name, auto_increment FROM information_schema.tables WHERE table_schema = DATABASE() AND table_name IN ('orders','order_lines') ORDER BY table_name") -split "`n"
    Test-Case 'C1: next AUTO_INCREMENT is 1 for orders and order_lines' ($ai.Count -eq 2 -and ($ai -contains "orders`t1") -and ($ai -contains "order_lines`t1")) ($ai -join '|')
    $first = Invoke-Api -Method POST -Path '/orders' -Body @{ customer_id = 1; lines = @(@{ product_id = 1; quantity = 20 }) }
    $lineIds = Invoke-Sql 'SELECT MIN(id), MAX(id) FROM order_lines'
    Test-Case 'C2: first order after reset gets id 1 and first line gets id 1' ($first.Body.data.order_id -eq 1 -and $lineIds -eq "1`t1") "order_id=$($first.Body.data.order_id) lines=$lineIds"

    Reset-Legacy | Out-Null
    $snap1 = Get-StateSnapshot
    $again = Invoke-Api -Method POST -Path '/reset'
    $snap2 = Get-StateSnapshot
    Test-Case 'D1: second consecutive reset succeeds and deletes nothing' (
        $again.Status -eq 200 -and $again.Body.data.orders_deleted -eq 0 -and $again.Body.data.order_lines_deleted -eq 0
    ) $again.Raw
    Test-Case 'D2: state after two consecutive resets is identical' ($snap1 -eq $snap2)

    Reset-Legacy | Out-Null
    Invoke-Api -Method POST -Path '/orders' -Body @{ customer_id = 1; lines = @(@{ product_id = 1; quantity = 20 }) } | Out-Null
    $snapBefore = Get-StateSnapshot
    $trigger = "DROP TRIGGER IF EXISTS trg_test_block_order_delete; CREATE TRIGGER trg_test_block_order_delete BEFORE DELETE ON orders FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'injected failure'"
    Invoke-Sql $trigger | Out-Null
    try {
        $fail = Invoke-Api -Method POST -Path '/reset'
        Test-Case 'E1: reset fails with 500 and success=false' ($fail.Status -eq 500 -and $fail.Body.success -eq $false) $fail.Raw
        Test-Case 'E2: failure report names the step and says rolled_back' (
            $fail.Body.details.step -eq 'delete orders' -and $fail.Body.details.state -eq 'rolled_back'
        ) $fail.Raw
        $snapAfter = Get-StateSnapshot
        Test-Case 'E3: database is exactly as before (order_lines delete was rolled back too)' ($snapBefore -eq $snapAfter)
        Test-Case 'E4: order and stock change are still visible through the API' (
            (Invoke-Api -Method GET -Path '/orders').Body.data.Count -eq 1 -and (Invoke-Api -Method GET -Path '/products/1').Body.data.stock_quantity -eq 480
        )
    } finally {
        Invoke-Sql 'DROP TRIGGER IF EXISTS trg_test_block_order_delete' | Out-Null
    }
    $rec = Invoke-Api -Method POST -Path '/reset'
    Test-Case 'E5: reset succeeds again once the fault is removed' ($rec.Status -eq 200 -and $rec.Body.success -eq $true) $rec.Raw

    Reset-Legacy | Out-Null
    Invoke-Api -Method POST -Path '/orders' -Body @{ customer_id = 1; lines = @(@{ product_id = 1; quantity = 20 }) } | Out-Null
    $cid = Get-DbContainerId
    $holder = Start-Job -ScriptBlock {
        param($ContainerId)
        'START TRANSACTION; SELECT COUNT(*) FROM orders; DO SLEEP(14); COMMIT;' |
            docker exec -i $ContainerId sh -c 'MYSQL_PWD="$MYSQL_PASSWORD" mysql -u"$MYSQL_USER" "$MYSQL_DATABASE" --batch --skip-column-names'
    } -ArgumentList $cid
    try {
        $held = 0
        for ($i = 0; $i -lt 10 -and $held -lt 1; $i++) {
            Start-Sleep -Seconds 1
            $held = [int](Invoke-Sql "SELECT COUNT(*) FROM information_schema.processlist WHERE info LIKE '%SLEEP(14)%'")
        }
        Test-Case 'F0: metadata lock holder is running' ($held -ge 1)
        $sw = [Diagnostics.Stopwatch]::StartNew()
        $ddl = Invoke-Api -Method POST -Path '/reset' -TimeoutSec 60
        $sw.Stop()
        Test-Case 'F1: reset does not report success when the AUTO_INCREMENT step fails' ($ddl.Status -eq 500 -and $ddl.Body.success -eq $false) $ddl.Raw
        Test-Case 'F2: failure report says the data reset is done but AUTO_INCREMENT is pending' (
            $ddl.Body.details.step -eq 'reset auto_increment orders' -and $ddl.Body.details.state -eq 'data_reset_auto_increment_pending'
        ) $ddl.Raw
        Test-Case 'F3: reset gave up after the lock wait timeout instead of hanging' ($sw.Elapsed.TotalSeconds -ge 4 -and $sw.Elapsed.TotalSeconds -lt 30) ("elapsed={0:N1}s" -f $sw.Elapsed.TotalSeconds)
        Test-Case 'F4: the reported partial state is real (orders are already gone)' ((Invoke-Api -Method GET -Path '/orders').Body.data.Count -eq 0)
    } finally {
        Wait-Job $holder -Timeout 40 | Out-Null
        Stop-Job $holder -ErrorAction SilentlyContinue
        Remove-Job $holder -Force -ErrorAction SilentlyContinue
    }
    $heal = Invoke-Api -Method POST -Path '/reset'
    Test-Case 'F5: a repeated reset completes the incomplete state' ($heal.Status -eq 200 -and $heal.Body.success -eq $true) $heal.Raw
    $post = Invoke-Api -Method POST -Path '/orders' -Body @{ customer_id = 1; lines = @(@{ product_id = 1; quantity = 20 }) }
    Test-Case 'F6: order ids restart at 1 after the repeated reset' ($post.Body.data.order_id -eq 1) $post.Raw

    Reset-Legacy | Out-Null
    $leftover = Invoke-Sql 'SELECT COUNT(*) FROM information_schema.triggers WHERE trigger_schema = DATABASE()'
    Test-Case 'cleanup: no test trigger left behind' ([int]$leftover -eq 0)
}
