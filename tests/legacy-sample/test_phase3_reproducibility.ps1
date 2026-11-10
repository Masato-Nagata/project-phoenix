#Requires -Version 7.0
. (Join-Path $PSScriptRoot 'lib/common.ps1')

function Add-Log {
    param($Log, [string]$Label, $Response)
    $Log.Add(("{0} => {1} {2}" -f $Label, $Response.Status, $Response.Raw))
}

function Invoke-Scenario {
    Reset-Legacy | Out-Null
    $log = New-Object System.Collections.Generic.List[string]

    $a = Invoke-Api -Method POST -Path '/orders' -Body @{ customer_id = 1; lines = @(@{ product_id = 1; quantity = 20 }) }
    Add-Log $log 'place A' $a
    $b = Invoke-Api -Method POST -Path '/orders' -Body @{ customer_id = 2; lines = @(@{ product_id = 4; quantity = 9 }) }
    Add-Log $log 'place B' $b
    $c = Invoke-Api -Method POST -Path '/orders' -Body @{ customer_id = 3; lines = @(@{ product_id = 5; quantity = 7 }, @{ product_id = 3; quantity = 4 }) }
    Add-Log $log 'place C' $c
    Add-Log $log 'place D (below minimum)' (Invoke-Api -Method POST -Path '/orders' -Body @{ customer_id = 1; lines = @(@{ product_id = 2; quantity = 12 }) })
    Add-Log $log 'place E (insufficient stock)' (Invoke-Api -Method POST -Path '/orders' -Body @{ customer_id = 1; lines = @(@{ product_id = 5; quantity = 51 }) })
    Add-Log $log 'place F (unknown product)' (Invoke-Api -Method POST -Path '/orders' -Body @{ customer_id = 1; lines = @(@{ product_id = 999; quantity = 1 }) })
    Add-Log $log 'place G (unknown customer)' (Invoke-Api -Method POST -Path '/orders' -Body @{ customer_id = 999; lines = @(@{ product_id = 1; quantity = 7 }) })

    $idA = $a.Body.data.order_id
    $idB = $b.Body.data.order_id
    $idC = $c.Body.data.order_id
    Add-Log $log 'cancel A' (Invoke-Api -Method POST -Path "/orders/$idA/cancel")
    Add-Log $log 'ship B' (Invoke-Api -Method POST -Path "/test/orders/$idB/ship")
    Add-Log $log 'cancel B (shipped)' (Invoke-Api -Method POST -Path "/orders/$idB/cancel")
    Add-Log $log 'cancel A again' (Invoke-Api -Method POST -Path "/orders/$idA/cancel")
    Add-Log $log 'cancel missing order' (Invoke-Api -Method POST -Path '/orders/999/cancel')
    Add-Log $log 'list orders' (Invoke-Api -Method GET -Path '/orders')

    $details = @()
    foreach ($id in @($idA, $idB, $idC)) {
        $d = Invoke-Api -Method GET -Path "/orders/$id"
        Add-Log $log "get order $id" $d
        $details += $d
    }
    Add-Log $log 'get missing order' (Invoke-Api -Method GET -Path '/orders/999')
    $products = Invoke-Api -Method GET -Path '/products'
    Add-Log $log 'list products' $products

    $sql = @(
        "SELECT id, customer_id, status, subtotal, discount, shipping_fee, total FROM orders ORDER BY id;",
        "SELECT id, order_id, product_id, quantity, unit_price FROM order_lines ORDER BY id;",
        "SELECT id, name, unit_price, stock_quantity FROM products ORDER BY id;",
        "SELECT id, name FROM customers ORDER BY id;"
    ) -join "`n"

    [pscustomobject]@{
        Ids      = @($idA, $idB, $idC)
        Raw      = ($log -join "`n")
        Details  = $details
        Products = $products.Body.data
        Snapshot = (Invoke-Sql $sql)
    }
}

function Add-Junk {
    $j1 = Invoke-Api -Method POST -Path '/orders' -Body @{ customer_id = 3; lines = @(@{ product_id = 4; quantity = 9 }) }
    $j2 = Invoke-Api -Method POST -Path '/orders' -Body @{ customer_id = 1; lines = @(@{ product_id = 1; quantity = 30 }) }
    Invoke-Api -Method POST -Path "/orders/$($j1.Body.data.order_id)/cancel" | Out-Null
    Invoke-Api -Method POST -Path "/test/orders/$($j2.Body.data.order_id)/ship" | Out-Null
    $dirty = @(
        "INSERT INTO products (id, name, unit_price, stock_quantity) VALUES (101, 'Leftover', 1, 5);",
        "UPDATE products SET unit_price = 999, stock_quantity = 1 WHERE id = 1;"
    ) -join "`n"
    Invoke-Sql $dirty | Out-Null
}

function Get-FirstDifference {
    param([string]$Expected, [string]$Actual)
    $e = $Expected -split "`n"
    $a = $Actual -split "`n"
    for ($i = 0; $i -lt [Math]::Max($e.Count, $a.Count); $i++) {
        if ($i -ge $e.Count -or $i -ge $a.Count -or $e[$i] -ne $a[$i]) {
            return "line $($i + 1): expected [$($e[$i])] actual [$($a[$i])]"
        }
    }
    'none'
}

Invoke-TestMain {
    Write-Host '=== Phase 3: reproducibility (reset -> same input -> same result) ===' -ForegroundColor Cyan

    $runs = @()
    for ($k = 1; $k -le 3; $k++) {
        if ($k -gt 1) {
            Add-Junk
            Start-Sleep -Milliseconds 1300
        }
        $runs += Invoke-Scenario
    }

    $norm = @($runs | ForEach-Object { ConvertTo-NormalizedText $_.Raw })

    for ($k = 0; $k -lt 3; $k++) {
        $n = $k + 1
        Test-Case "cycle ${n}: order ids restart at 1,2,3" (($runs[$k].Ids -join ',') -eq '1,2,3') ($runs[$k].Ids -join ',')
        Test-Case "cycle ${n}: created_at present and ISO 8601 in all 6 order payloads" ($norm[$k].AllValid -and $norm[$k].Timestamps.Count -eq 6) ("count=$($norm[$k].Timestamps.Count)")
    }

    Test-Case 'raw responses differ between cycle 1 and 2 (created_at is non-deterministic)' ($runs[1].Raw -ne $runs[0].Raw)
    Test-Case 'created_at values differ between cycle 1 and 2' (($norm[0].Timestamps -join ',') -ne ($norm[1].Timestamps -join ','))
    foreach ($k in 1, 2) {
        $n = $k + 1
        $same = ($norm[$k].Text -eq $norm[0].Text)
        $diff = if ($same) { '' } else { Get-FirstDifference $norm[0].Text $norm[$k].Text }
        Test-Case "cycle ${n}: responses identical to cycle 1 after masking created_at" $same $diff
        $sameSnap = ($runs[$k].Snapshot -eq $runs[0].Snapshot)
        $diffSnap = if ($sameSnap) { '' } else { Get-FirstDifference $runs[0].Snapshot $runs[$k].Snapshot }
        Test-Case "cycle ${n}: database state identical to cycle 1 (orders, lines, products, customers)" $sameSnap $diffSnap
    }

    for ($k = 0; $k -lt 3; $k++) {
        $n = $k + 1
        $dA = $runs[$k].Details[0].Body.data
        $dB = $runs[$k].Details[1].Body.data
        $dC = $runs[$k].Details[2].Body.data
        Test-Case "cycle ${n}: order A detail (cancelled) has expected amounts and line" (
            $dA.status -eq 'cancelled' -and $dA.subtotal -eq 3000 -and $dA.discount -eq 300 -and $dA.shipping_fee -eq 500 -and $dA.total -eq 3200 -and
            $dA.lines.Count -eq 1 -and $dA.lines[0].product_id -eq 1 -and $dA.lines[0].quantity -eq 20 -and $dA.lines[0].unit_price -eq 150
        )
        Test-Case "cycle ${n}: order B detail (shipped) has expected amounts and line" (
            $dB.status -eq 'shipped' -and $dB.subtotal -eq 10800 -and $dB.discount -eq 1000 -and $dB.shipping_fee -eq 0 -and $dB.total -eq 9800 -and
            $dB.lines.Count -eq 1 -and $dB.lines[0].product_id -eq 4 -and $dB.lines[0].quantity -eq 9 -and $dB.lines[0].unit_price -eq 1200
        )
        Test-Case "cycle ${n}: order C detail (pending) has expected amounts and two lines" (
            $dC.status -eq 'pending' -and $dC.subtotal -eq 6400 -and $dC.discount -eq 300 -and $dC.shipping_fee -eq 0 -and $dC.total -eq 6100 -and
            $dC.lines.Count -eq 2 -and $dC.lines[0].product_id -eq 5 -and $dC.lines[0].quantity -eq 7 -and $dC.lines[1].product_id -eq 3 -and $dC.lines[1].quantity -eq 4
        )
        $stock = @{}
        foreach ($p in $runs[$k].Products) { $stock[[int]$p.id] = [int]$p.stock_quantity }
        Test-Case "cycle ${n}: final stock matches expected literals (p1=500 after cancel, p2=1000, p3=296, p4=91, p5=43)" (
            $runs[$k].Products.Count -eq 5 -and $stock[1] -eq 500 -and $stock[2] -eq 1000 -and $stock[3] -eq 296 -and $stock[4] -eq 91 -and $stock[5] -eq 43
        ) (($stock.GetEnumerator() | Sort-Object Name | ForEach-Object { "p$($_.Name)=$($_.Value)" }) -join ' ')
    }

    $empty = Invoke-Api -Method GET -Path '/orders'
    Test-Case 'order list endpoint is consistent after the last cycle (3 orders)' ($empty.Body.data.Count -eq 3)
    Reset-Legacy | Out-Null
    Test-Case 'order list is empty after a final reset' ((Invoke-Api -Method GET -Path '/orders').Body.data.Count -eq 0)
}