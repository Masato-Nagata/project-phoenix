$ProgressPreference = 'SilentlyContinue'
$ErrorActionPreference = 'Stop'

$script:RepoRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../../..'))
$script:BaseUrl = if ($env:LEGACY_BASE_URL) { $env:LEGACY_BASE_URL } else { 'http://127.0.0.1:8056' }
$script:PassCount = 0
$script:FailCount = 0
$script:DbContainerId = $null
$script:IsoPattern = '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2}$'

function Test-Case {
    param(
        [Parameter(Mandatory)][string]$Name,
        [Parameter(Mandatory)][bool]$Condition,
        [string]$Detail = ''
    )
    if ($Condition) {
        Write-Host "PASS: $Name" -ForegroundColor Green
        $script:PassCount++
    } else {
        $msg = "FAIL: $Name"
        if ($Detail) { $msg += "  ($Detail)" }
        Write-Host $msg -ForegroundColor Red
        $script:FailCount++
    }
}

function Invoke-Api {
    param(
        [Parameter(Mandatory)][string]$Method,
        [Parameter(Mandatory)][string]$Path,
        $Body = $null,
        [int]$TimeoutSec = 30
    )
    $req = @{
        Uri                = "$script:BaseUrl$Path"
        Method             = $Method
        UseBasicParsing    = $true
        SkipHttpErrorCheck = $true
        TimeoutSec         = $TimeoutSec
    }
    if ($null -ne $Body) {
        $req.Body = ($Body | ConvertTo-Json -Depth 10 -Compress)
        $req.ContentType = 'application/json'
    }
    $r = Invoke-WebRequest @req
    $parsed = $null
    try { $parsed = $r.Content | ConvertFrom-Json -Depth 10 } catch { }
    [pscustomobject]@{ Status = [int]$r.StatusCode; Raw = [string]$r.Content; Body = $parsed }
}

function Reset-Legacy {
    $r = Invoke-Api -Method POST -Path '/reset'
    if ($r.Status -ne 200 -or -not $r.Body.success) {
        throw "Reset failed: HTTP $($r.Status) $($r.Raw)"
    }
    $r
}

function Get-DbContainerId {
    if (-not $script:DbContainerId) {
        $composeFile = Join-Path $script:RepoRoot 'infra/docker-compose.yml'
        $id = (& docker compose -f $composeFile --project-directory $script:RepoRoot ps -q legacy-db 2>$null | Select-Object -First 1)
        if (-not $id) { throw 'legacy-db container not found. Start it with: docker compose -f infra/docker-compose.yml --project-directory . up -d --build' }
        $script:DbContainerId = "$id".Trim()
    }
    $script:DbContainerId
}

function Invoke-Sql {
    param([Parameter(Mandatory)][string]$Sql)
    $id = Get-DbContainerId
    $out = $Sql | & docker exec -i $id sh -c 'MYSQL_PWD="$MYSQL_PASSWORD" mysql -u"$MYSQL_USER" "$MYSQL_DATABASE" --batch --skip-column-names' 2>&1
    if ($LASTEXITCODE -ne 0) { throw "SQL failed: $(($out | ForEach-Object { "$_" }) -join ' ')" }
    (($out | ForEach-Object { "$_" }) -join "`n").Trim()
}

function ConvertTo-NormalizedText {
    param([Parameter(Mandatory)][string]$Text)
    $stamps = @([regex]::Matches($Text, '"created_at":"([^"]*)"') | ForEach-Object { $_.Groups[1].Value })
    $masked = [regex]::Replace($Text, '"created_at":"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2}"', '"created_at":"<TIMESTAMP>"')
    $invalid = @($stamps | Where-Object { $_ -notmatch $script:IsoPattern })
    [pscustomobject]@{ Text = $masked; Timestamps = $stamps; AllValid = ($invalid.Count -eq 0) }
}

function Read-SeedSql {
    $text = Get-Content -Raw (Join-Path $script:RepoRoot 'legacy/sql/seed.sql')
    $products = @([regex]::Matches($text, "\(\s*(\d+)\s*,\s*'([^']*)'\s*,\s*(\d+)\s*,\s*(\d+)\s*\)") | ForEach-Object {
        [pscustomobject]@{
            id = [int]$_.Groups[1].Value; name = $_.Groups[2].Value
            unit_price = [int]$_.Groups[3].Value; stock_quantity = [int]$_.Groups[4].Value
        }
    })
    $customers = @([regex]::Matches($text, "\(\s*(\d+)\s*,\s*'([^']*)'\s*\)") | ForEach-Object {
        [pscustomobject]@{ id = [int]$_.Groups[1].Value; name = $_.Groups[2].Value }
    })
    [pscustomobject]@{ Products = $products; Customers = $customers }
}

function Exit-WithSummary {
    Write-Host ''
    Write-Host '========================================' -ForegroundColor Cyan
    $color = if ($script:FailCount -eq 0) { 'Green' } else { 'Yellow' }
    Write-Host ("Results: {0} passed, {1} failed" -f $script:PassCount, $script:FailCount) -ForegroundColor $color
    Write-Host '========================================' -ForegroundColor Cyan
    if ($script:FailCount -gt 0) { exit 1 } else { exit 0 }
}

function Invoke-TestMain {
    param([Parameter(Mandatory)][scriptblock]$Body)
    try {
        & $Body
    } catch {
        Write-Host ("FAIL: unexpected error: " + $_.Exception.Message) -ForegroundColor Red
        $script:FailCount++
    }
    Exit-WithSummary
}