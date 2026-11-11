#Requires -Version 7.0
# Static checks of the Ground Truth, the migration decision registry and the AI input allowlist.
# No container is needed. Expected values are checked for internal consistency only; they are
# never compared with, or adjusted to, legacy behavior here.
. (Join-Path $PSScriptRoot 'lib/common.ps1')

function Get-AllKeys {
    param($Node)
    $keys = New-Object System.Collections.Generic.List[string]
    if ($Node -is [System.Management.Automation.PSCustomObject]) {
        foreach ($p in $Node.PSObject.Properties) { $keys.Add($p.Name); foreach ($k in (Get-AllKeys $p.Value)) { $keys.Add($k) } }
    } elseif ($Node -is [System.Collections.IEnumerable] -and $Node -isnot [string]) {
        foreach ($i in $Node) { foreach ($k in (Get-AllKeys $i)) { $keys.Add($k) } }
    }
    $keys
}

function Get-TierValue {
    param($Tiers, [string]$MinKey, [string]$MaxKey, [string]$ValueKey, [int]$Amount)
    foreach ($t in $Tiers) {
        $max = $t.$MaxKey
        if ($Amount -ge [int]$t.$MinKey -and ($null -eq $max -or $Amount -le [int]$max)) { return [int]$t.$ValueKey }
    }
    throw "no tier for $Amount"
}

function Get-Unit6 { param($Gt) $Gt.scenarios | Where-Object id -eq 'SCN-006' }

Invoke-TestMain {
    $gtPath = Join-Path $script:RepoRoot 'evaluation/ground-truth/ground-truth.json'
    $gt = Get-Content -Raw $gtPath | ConvertFrom-Json -Depth 40 -DateKind String
    $decisions = Get-Content -Raw (Join-Path $script:RepoRoot 'evaluation/migration-decisions.json') | ConvertFrom-Json -Depth 40 -DateKind String
    $allow = Get-Content -Raw (Join-Path $script:RepoRoot 'docs/ai-input-allowlist.json') | ConvertFrom-Json -Depth 10

    # --- meta ---
    Test-Case 'GS1 schema_version is 1' ($gt.schema_version -eq 1)
    Test-Case 'GS2 meta.kind is expected_specification' ($gt.meta.kind -eq 'expected_specification')
    $au = $gt.meta.authoring
    Test-Case 'GS3 Ground Truth is approved by the project owner with a recorded ISO 8601 approval time' ($au.status -eq 'approved' -and $au.approved_by -eq 'Masato Nagata (project owner)' -and [string]$au.approved_at -match '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2}$') ($au | ConvertTo-Json -Compress -Depth 5)
    Test-Case 'GS4 canary has the expected format' ([string]$gt.meta.canary -match '^PHOENIX-GT-CANARY-[0-9a-f]{32}$') ([string]$gt.meta.canary).Length
    Test-Case 'GS5 never_pass_to_runtime_ai is true' ($gt.meta.never_pass_to_runtime_ai -eq $true)
    Test-Case 'GS6 minimum order value is a literal 1000 (R9.7)' (($gt.meta.minimum_order_value -is [long] -or $gt.meta.minimum_order_value -is [int]) -and ([int]$gt.meta.minimum_order_value -eq 1000))
    $dt = @($gt.meta.discount_tiers | ForEach-Object { "$($_.subtotal_min)-$($_.subtotal_max):$($_.discount)" }) -join ','
    Test-Case 'GS7 discount tiers are literal constants (R9.7)' ($dt -eq '0-2999:0,3000-9999:300,10000-:1000') $dt
    $st = @($gt.meta.shipping_fee_tiers | ForEach-Object { "$($_.net_amount_min)-$($_.net_amount_max):$($_.shipping_fee)" }) -join ','
    Test-Case 'GS8 shipping fee tiers are literal constants (R9.7)' ($st -eq '0-4999:500,5000-:0') $st

    # --- scenarios ---
    $ids = @($gt.scenarios | ForEach-Object { $_.id })
    $expectedIds = @(1..17 | ForEach-Object { 'SCN-{0:D3}' -f $_ })
    Test-Case 'GS9 scenarios are SCN-001..SCN-017 in order, unique' (($ids -join ',') -eq ($expectedIds -join ',')) ($ids -join ',')

    $units = New-Object System.Collections.Generic.List[object]
    foreach ($s in $gt.scenarios) {
        if ($s.PSObject.Properties['variants']) { foreach ($v in $s.variants) { $units.Add($v) } } else { $units.Add($s) }
    }
    $unitIds = @($units | ForEach-Object { $_.id })
    Test-Case 'GS10 there are 20 scenario units (SCN-017 has variants a-d)' ($units.Count -eq 20 -and (($unitIds | Where-Object { $_ -like 'SCN-017-*' }) -join ',') -eq 'SCN-017-a,SCN-017-b,SCN-017-c,SCN-017-d') ($unitIds -join ',')
    Test-Case 'GS11 scenario unit ids are unique' (@($unitIds | Sort-Object -Unique).Count -eq $unitIds.Count)

    $required = @('successful_order_monetary', 'rejection_minimum_order_value', 'rejection_insufficient_stock', 'rejection_missing_product', 'cancellation_with_stock_restoration', 'cancellation_rejected')
    $cats = @($gt.scenarios | ForEach-Object { $_.category })
    $missingCats = @($required | Where-Object { $_ -notin $cats })
    Test-Case 'GS12 every R9.6 category has at least one scenario' ($missingCats.Count -eq 0) ($missingCats -join ',')

    $badUnits = New-Object System.Collections.Generic.List[string]
    foreach ($u in $units) {
        $steps = @($u.steps)
        $actions = @($steps | Where-Object { $_.role -eq 'action' })
        $roleOk = @($steps | Where-Object { $_.role -notin 'setup', 'action' }).Count -eq 0
        $es = $u.expected_specification
        $hasSpec = $null -ne $es -and $null -ne $es.step_expectations -and $null -ne $es.PSObject.Properties['state_checks']
        $src = if ($es) { [string]$es.response_code_source } else { '' }
        $actionExp = $true
        foreach ($a in $actions) { if (-not $es.step_expectations.PSObject.Properties[$a.id]) { $actionExp = $false } }
        $statusOk = $true
        foreach ($p in $es.step_expectations.PSObject.Properties) { if ($null -eq $p.Value.status -and -not $p.Value.PSObject.Properties['undetermined']) { $statusOk = $false } }
        if (-not ($actions.Count -ge 1 -and $roleOk -and $hasSpec -and $actionExp -and $statusOk -and $src -in 'design', 'human_approved' -and $es.derived_from)) { $badUnits.Add($u.id) }
    }
    Test-Case 'GS13 every unit has action steps, an expectation per action, a status, a source and a derivation (R9.5)' ($badUnits.Count -eq 0) ($badUnits -join ',')

    $approvedSrc = @($units | Where-Object { $_.expected_specification.response_code_source -eq 'human_approved' } | ForEach-Object { $_.id })
    $pendingAny = @($units | Where-Object { $_.expected_specification.response_code_source -notin 'design', 'human_approved' } | ForEach-Object { $_.id })
    Test-Case 'GS14 no unit is pending human confirmation; SCN-015..SCN-017-d carry the human-approved response' (($approvedSrc -join ',') -eq 'SCN-015,SCN-016,SCN-017-a,SCN-017-b,SCN-017-c,SCN-017-d' -and $pendingAny.Count -eq 0) (($approvedSrc -join ',') + ' / pending=' + ($pendingAny -join ','))

    $invalidQ = @($units | Where-Object { $_.id -in 'SCN-015', 'SCN-016', 'SCN-017-a', 'SCN-017-b', 'SCN-017-c', 'SCN-017-d' })
    $r313 = @($invalidQ | Where-Object { $es = $_.expected_specification; $e = $es.step_expectations.s1; $chk = (@($es.state_checks | ForEach-Object { "$($_.request.path)=$(ConvertTo-Json $_.fields -Compress)" }) -join ';'); -not ($e.status -eq 400 -and $e.fields.success -eq $false -and $e.fields.error -eq 'Invalid request' -and $chk -eq '/orders={"data":[]};/products/1={"data.stock_quantity":500}') } | ForEach-Object { $_.id })
    Test-Case 'GS15 all six invalid-quantity units (incl. numeric string) expect 400 "Invalid request", no order and unchanged stock (R3.13)' ($r313.Count -eq 0) ($r313 -join ',')

    $allKeys = @(Get-AllKeys $gt)
    $obsKeys = @($allKeys | Where-Object { $_ -match '^(observed|actual|legacy_)' } | Sort-Object -Unique)
    Test-Case 'GS16 Ground Truth holds no observed/actual legacy behavior keys' ($obsKeys.Count -eq 0) ($obsKeys -join ',')

    # Successful monetary scenarios: totals are consistent with the literal tiers.
    $bad = New-Object System.Collections.Generic.List[string]
    foreach ($u in $units) {
        foreach ($p in $u.expected_specification.step_expectations.PSObject.Properties) {
            $f = $p.Value.fields
            if ($p.Value.status -eq 201 -and $f -and $f.PSObject.Properties['data.subtotal']) {
                $sub = [int]$f.'data.subtotal'
                $d = Get-TierValue $gt.meta.discount_tiers 'subtotal_min' 'subtotal_max' 'discount' $sub
                $fee = Get-TierValue $gt.meta.shipping_fee_tiers 'net_amount_min' 'net_amount_max' 'shipping_fee' ($sub - $d)
                if ([int]$f.'data.discount' -ne $d -or [int]$f.'data.shipping_fee' -ne $fee -or [int]$f.'data.total' -ne ($sub - $d + $fee)) { $bad.Add("$($u.id)/$($p.Name)") }
            }
        }
    }
    Test-Case 'GS17 expected monetary values agree with the literal tiers' ($bad.Count -eq 0) ($bad -join ',')

    # --- boundary cases ---
    $bcs = @($gt.boundary_cases)
    $subs = @($bcs | ForEach-Object { [int]$_.subtotal })
    Test-Case 'GS18 boundary cases cover 0, 999, 1000, 2999, 3000, 4999, 5000, 9999, 10000 and the net-amount cases 5299, 5300' (($subs -join ',') -eq '0,999,1000,2999,3000,4999,5000,9999,10000,5299,5300' -and ((@($bcs | ForEach-Object { $_.id }) -join ',') -eq ((1..11 | ForEach-Object { 'BC-{0:D3}' -f $_ }) -join ','))) ($subs -join ',')
    $badBc = New-Object System.Collections.Generic.List[string]
    foreach ($bc in $bcs) {
        $sub = [int]$bc.subtotal
        $d = Get-TierValue $gt.meta.discount_tiers 'subtotal_min' 'subtotal_max' 'discount' $sub
        $fee = Get-TierValue $gt.meta.shipping_fee_tiers 'net_amount_min' 'net_amount_max' 'shipping_fee' ($sub - $d)
        $accept = $sub -ge [int]$gt.meta.minimum_order_value
        $ok = ([bool]$bc.order_accepted -eq $accept) -and ([int]$bc.expected_discount -eq $d) -and ([int]$bc.expected_shipping_fee -eq $fee)
        if ($accept) { $ok = $ok -and ([int]$bc.expected_total -eq ($sub - $d + $fee)) }
        elseif (-not ($bc.PSObject.Properties['execution'] -and $bc.execution -eq 'not_executed')) { $ok = $ok -and $bc.expected_rejection.status -eq 400 -and $bc.expected_rejection.error -eq 'Minimum order value not met' }
        if (-not $ok) { $badBc.Add($bc.id) }
    }
    Test-Case 'GS19 boundary expectations agree with minimum value and tiers' ($badBc.Count -eq 0) ($badBc -join ',')
    $notExec = @($bcs | Where-Object { $_.PSObject.Properties['execution'] -and $_.execution -eq 'not_executed' } | ForEach-Object { $_.id })
    Test-Case 'GS20 only BC-001 (subtotal 0) is not executed, with a reason' (($notExec -join ',') -eq 'BC-001' -and $bcs[0].reason) ($notExec -join ',')

    # --- defect candidate mapping ---
    $links = $gt.defect_candidate_links
    $dcIds = @($links.PSObject.Properties.Name)
    Test-Case 'GS21 defect candidate links cover DC-001..DC-006' (($dcIds -join ',') -eq 'DC-001,DC-002,DC-003,DC-004,DC-005,DC-006') ($dcIds -join ',')
    $badLinks = New-Object System.Collections.Generic.List[string]
    foreach ($p in $links.PSObject.Properties) {
        $u = $units | Where-Object { $_.id -eq $p.Value.scenario }
        if (-not $u -or $p.Name -notin @($u.defect_candidates)) { $badLinks.Add($p.Name) }
    }
    Test-Case 'GS22 each defect candidate links to a unit that lists it back' ($badLinks.Count -eq 0) ($badLinks -join ',')
    $dcDoc = Get-Content -Raw (Join-Path $script:RepoRoot 'evaluation/legacy-defect-candidates.md')
    $missingDoc = @($dcIds | Where-Object { $dcDoc -notmatch ('\|\s*' + [regex]::Escape($_) + '\s*\|') })
    Test-Case 'GS23 every linked defect candidate is in legacy-defect-candidates.md' ($missingDoc.Count -eq 0) ($missingDoc -join ',')
    $unitDcs = @($units | ForEach-Object { @($_.defect_candidates) } | Where-Object { $_ } | Sort-Object)
    Test-Case 'GS24 no unit references an unknown defect candidate' ((($unitDcs | Where-Object { $_ -notin $dcIds }).Count -eq 0) -and $unitDcs.Count -eq 6) ($unitDcs -join ',')

    $d = $units | Where-Object { $_.id -eq 'SCN-017-d' }
    $s1d = $d.expected_specification.step_expectations.s1
    Test-Case 'GS25 SCN-017-d (numeric string "5") is decided: 400 Invalid request, no longer undetermined' ($d.expected_specification.response_code_source -eq 'human_approved' -and -not $s1d.PSObject.Properties['undetermined'] -and $s1d.status -eq 400 -and @($d.expected_specification.state_checks).Count -eq 2) ($d.expected_specification | ConvertTo-Json -Compress -Depth 6)

    # --- migration decision registry ---
    $entries = @($decisions.decisions)
    $mdIds = @($entries | ForEach-Object { $_.id })
    Test-Case 'GS26 registry has MD-001..MD-006' (($mdIds -join ',') -eq 'MD-001,MD-002,MD-003,MD-004,MD-005,MD-006') ($mdIds -join ',')
    $badMd = New-Object System.Collections.Generic.List[string]
    foreach ($e in $entries) {
        $u = $units | Where-Object { $_.id -eq $e.scenario }
        $same = $u -and ((@($e.defect_candidates) -join ',') -eq (@($u.defect_candidates) -join ','))
        if (-not $same -or $e.decision -notin @($decisions.allowed_decisions)) { $badMd.Add($e.id) }
    }
    Test-Case 'GS27 every decision refers to an existing unit with the same defect candidates' ($badMd.Count -eq 0) ($badMd -join ',')
    $badDecided = @($entries | Where-Object { $_.decision -ne 'follow_expected_specification' -or $_.decided_by -ne 'Masato Nagata (project owner)' -or [string]$_.decided_at -notmatch '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2}$' -or -not [string]$_.rationale } | ForEach-Object { $_.id })
    Test-Case 'GS28 MD-001..MD-006 are decided follow_expected_specification by the project owner, with ISO 8601 time and rationale' ($badDecided.Count -eq 0) ($badDecided -join ',')

    $undet = @($units | Where-Object { @($_.expected_specification.step_expectations.PSObject.Properties | Where-Object { $_.Value.PSObject.Properties['undetermined'] }).Count -gt 0 } | ForEach-Object { $_.id })
    Test-Case 'GS31 no unit has an undetermined expectation' ($undet.Count -eq 0) ($undet -join ',')
    $kinds = @($entries | ForEach-Object { "$($_.id)=$($_.kind)" }) -join ','
    $md6 = $entries | Where-Object id -eq 'MD-006'
    $h6 = @($md6.history)
    Test-Case 'GS32 all six are migration decisions; MD-006 keeps DC-005 and its closed specification-decision history' ($kinds -eq 'MD-001=migration_decision,MD-002=migration_decision,MD-003=migration_decision,MD-004=migration_decision,MD-005=migration_decision,MD-006=migration_decision' -and (@($md6.defect_candidates) -join ',') -eq 'DC-005' -and $md6.scenario -eq 'SCN-017-d' -and $h6.Count -eq 1 -and $h6[0].kind -eq 'specification_decision' -and [string]$h6[0].closed_at -match '^\d{4}-') $kinds
    # BC-001 cannot be executed inside the data domain: every product price is at least 1 (schema CHECK)
    # and a quantity must be a positive integer (R3.13), so no valid order line has a subtotal of 0.
    $schema = Get-Content -Raw (Join-Path $script:RepoRoot 'legacy/sql/schema.sql')
    $seedPrices = @((Read-SeedSql).Products | ForEach-Object { $_.unit_price })
    Test-Case 'GS33 BC-001 is not executable: schema declares unit_price BETWEEN 1 AND 9999999 and every seed price is >= 1' (($schema -match 'CHECK\s*\(\s*unit_price\s+BETWEEN\s+1\s+AND') -and $seedPrices.Count -gt 0 -and @($seedPrices | Where-Object { $_ -lt 1 }).Count -eq 0) ("prices=" + ($seedPrices -join ','))
    $e6 = (Get-Unit6 $gt).expected_specification.step_expectations.s1.fields
    Test-Case 'GS34 SCN-006 specifies product_id 5, available 50 and requested 51 for the insufficient line' ((ConvertTo-Json $e6.'details.products[*].product_id' -Compress) -eq '[5]' -and (ConvertTo-Json $e6.'details.products[*].available' -Compress) -eq '[50]' -and (ConvertTo-Json $e6.'details.products[*].requested' -Compress) -eq '[51]') (ConvertTo-Json $e6 -Compress)
    $b10 = $bcs | Where-Object id -eq 'BC-010'; $b11 = $bcs | Where-Object id -eq 'BC-011'
    Test-Case 'GS35 BC-010/BC-011 straddle the shipping threshold on the net amount (4999 -> 500, 5000 -> 0)' ($b10.subtotal -eq 5299 -and $b10.expected_discount -eq 300 -and $b10.expected_net_amount -eq 4999 -and $b10.expected_shipping_fee -eq 500 -and $b10.expected_total -eq 5499 -and $b11.subtotal -eq 5300 -and $b11.expected_discount -eq 300 -and $b11.expected_net_amount -eq 5000 -and $b11.expected_shipping_fee -eq 0 -and $b11.expected_total -eq 5000)
    $badNet = @($bcs | Where-Object { $_.PSObject.Properties['expected_net_amount'] -and [int]$_.expected_net_amount -ne ([int]$_.subtotal - [int]$_.expected_discount) } | ForEach-Object { $_.id })
    Test-Case 'GS36 every recorded expected_net_amount equals subtotal - discount' ($badNet.Count -eq 0) ($badNet -join ',')
    Test-Case 'GS37 registry maps follow_expected_specification to an approved divergence for the Compatibility_Evaluation' ([string]$decisions.compatibility_mapping.follow_expected_specification -match '^approved_divergence')
    # --- AI input allowlist ---
    $files = @($allow.files)
    $mdTable = @(Select-String -Path (Join-Path $script:RepoRoot 'docs/ai-input-allowlist.md') -Pattern '^\|\s*`(legacy/[^`]+)`\s*\|' | ForEach-Object { $_.Matches[0].Groups[1].Value })
    Test-Case 'GS29 allowlist JSON equals the table in ai-input-allowlist.md' (($files -join ',') -eq ($mdTable -join ',')) ("json=" + ($files -join ',') + " md=" + ($mdTable -join ','))
    $badPaths = @($files | Where-Object { $_ -notmatch '^legacy/(src|sql)/[A-Za-z0-9_]+\.(php|sql)$' -or -not (Test-Path -LiteralPath (Join-Path $script:RepoRoot $_) -PathType Leaf) })
    Test-Case 'GS30 allowlist holds 7 concrete existing files under legacy/src or legacy/sql, no wildcard' ($files.Count -eq 7 -and $badPaths.Count -eq 0) ($badPaths -join ',')
}