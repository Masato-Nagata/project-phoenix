$ProgressPreference = 'SilentlyContinue'

function Get-Sha256Lf {
    param([Parameter(Mandatory)][string]$Path)
    $text = [IO.File]::ReadAllText($Path).Replace("`r`n", "`n")
    $bytes = [Text.Encoding]::UTF8.GetBytes($text)
    ([BitConverter]::ToString([Security.Cryptography.SHA256]::Create().ComputeHash($bytes))).Replace('-', '').ToLowerInvariant()
}

function Invoke-EvalHttp {
    param(
        [Parameter(Mandatory)][string]$BaseUrl,
        [Parameter(Mandatory)][string]$Method,
        [Parameter(Mandatory)][string]$Path,
        $Body = $null
    )
    $req = @{
        Uri                = "$BaseUrl$Path"
        Method             = $Method
        UseBasicParsing    = $true
        SkipHttpErrorCheck = $true
        TimeoutSec         = 60
    }
    if ($null -ne $Body) {
        $req.Body = (ConvertTo-Json -InputObject $Body -Depth 20 -Compress)
        $req.ContentType = 'application/json'
    }
    $r = Invoke-WebRequest @req
    $parsed = $null
    try { $parsed = $r.Content | ConvertFrom-Json -Depth 20 } catch { }
    [pscustomobject]@{ Status = [int]$r.StatusCode; Raw = [string]$r.Content; Body = $parsed }
}

function Invoke-EvalSql {
    param([Parameter(Mandatory)][string]$RepoRoot, [Parameter(Mandatory)][string]$Sql)
    $composeFile = Join-Path $RepoRoot 'infra/docker-compose.yml'
    $id = (& docker compose -f $composeFile --project-directory $RepoRoot ps -q legacy-db 2>$null | Select-Object -First 1)
    if (-not $id) { throw 'legacy-db container not found' }
    $out = $Sql | & docker exec -i ("$id".Trim()) sh -c 'MYSQL_PWD="$MYSQL_PASSWORD" mysql -u"$MYSQL_USER" "$MYSQL_DATABASE" --batch --skip-column-names' 2>&1
    if ($LASTEXITCODE -ne 0) { throw "SQL failed: $(($out | ForEach-Object { "$_" }) -join ' ')" }
}

function Resolve-TemplateString {
    param([Parameter(Mandatory)][string]$Text, [Parameter(Mandatory)][hashtable]$Vars)
    $out = $Text
    foreach ($m in [regex]::Matches($Text, '\{\{(\w+)\}\}')) {
        $n = $m.Groups[1].Value
        if (-not $Vars.ContainsKey($n)) { throw "undefined template variable: $n" }
        $out = $out.Replace($m.Value, [string]$Vars[$n])
    }
    $out
}

function Resolve-Value {
    param($Value, [Parameter(Mandatory)][hashtable]$Vars)
    if ($null -eq $Value) { return $null }
    if ($Value -is [string]) {
        if ($Value -match '^\{\{(\w+)\}\}$') {
            if (-not $Vars.ContainsKey($Matches[1])) { throw "undefined template variable: $($Matches[1])" }
            return $Vars[$Matches[1]]
        }
        return (Resolve-TemplateString $Value $Vars)
    }
    if ($Value -is [System.Collections.IList]) {
        $list = New-Object System.Collections.ArrayList
        foreach ($v in $Value) { [void]$list.Add((Resolve-Value $v $Vars)) }
        return ,($list.ToArray())
    }
    if ($Value -is [pscustomobject]) {
        $h = [ordered]@{}
        foreach ($p in $Value.PSObject.Properties) { $h[$p.Name] = Resolve-Value $p.Value $Vars }
        return [pscustomobject]$h
    }
    $Value
}

function Get-PathValue {
    param($Object, [Parameter(Mandatory)][string]$Path)
    $missing = [pscustomobject]@{ Exists = $false; Value = $null }
    $cur = New-Object System.Collections.ArrayList
    [void]$cur.Add($Object)
    $wild = $false
    foreach ($m in [regex]::Matches($Path, '([^.\[\]]+)|\[(\d+|\*)\]')) {
        $next = New-Object System.Collections.ArrayList
        if ($m.Groups[1].Success) {
            $name = $m.Groups[1].Value
            foreach ($item in $cur) {
                if ($null -eq $item -or $item -is [string]) { return $missing }
                $prop = $item.PSObject.Properties[$name]
                if (-not $prop) { return $missing }
                [void]$next.Add($prop.Value)
            }
        } else {
            $ix = $m.Groups[2].Value
            foreach ($item in $cur) {
                $arr = @($item)
                if ($ix -eq '*') {
                    $wild = $true
                    foreach ($e in $arr) { [void]$next.Add($e) }
                } else {
                    $n = [int]$ix
                    if ($n -ge $arr.Count) { return $missing }
                    [void]$next.Add($arr[$n])
                }
            }
        }
        $cur = $next
    }
    if ($wild) { return [pscustomobject]@{ Exists = $true; Value = $cur.ToArray() } }
    [pscustomobject]@{ Exists = $true; Value = $cur[0] }
}

function ConvertTo-CanonicalJson {
    param($Value)
    ConvertTo-Json -InputObject $Value -Compress -Depth 20
}

function Test-FieldExpectation {
    param($Body, [Parameter(Mandatory)][string]$Path, $Expected)
    $got = Get-PathValue $Body $Path
    if (-not $got.Exists) { return "field '$Path' is missing in the response" }
    if ($Expected -is [pscustomobject] -and $Expected.PSObject.Properties['$type']) {
        $kind = $Expected.PSObject.Properties['$type'].Value
        $v = $got.Value
        $ok = switch ($kind) {
            'integer' { ($v -is [int] -or $v -is [long]) }
            'string'  { ($v -is [string]) }
            default   { $false }
        }
        if (-not $ok) { return "field '$Path' expected type $kind, observed $(ConvertTo-CanonicalJson $v)" }
        return $null
    }
    $e = ConvertTo-CanonicalJson $Expected
    $a = ConvertTo-CanonicalJson $got.Value
    if ($e -ne $a) { return "field '$Path' expected $e, observed $a" }
    $null
}

function Test-ResponseExpectation {
    param($Response, $Expect, [Parameter(Mandatory)][hashtable]$Vars)
    $diffs = New-Object System.Collections.Generic.List[string]
    if ($Expect.PSObject.Properties['undetermined']) {
        return [pscustomobject]@{ Comparable = $false; Differences = @() }
    }
    if ($Response.Status -ne [int]$Expect.status) {
        $diffs.Add("status: expected $($Expect.status), observed $($Response.Status)")
    }
    if ($Expect.PSObject.Properties['fields']) {
        foreach ($p in $Expect.fields.PSObject.Properties) {
            $expected = Resolve-Value $p.Value $Vars
            $msg = Test-FieldExpectation $Response.Body $p.Name $expected
            if ($msg) { $diffs.Add($msg) }
        }
    }
    if ($Expect.PSObject.Properties['must_not_contain']) {
        foreach ($needle in $Expect.must_not_contain) {
            $n = Resolve-TemplateString ([string]$needle) $Vars
            if ($Response.Raw.Contains($n)) { $diffs.Add('response body contains a forbidden string') }
        }
    }
    [pscustomobject]@{ Comparable = $true; Differences = $diffs.ToArray() }
}

function Get-MaskedBody {
    param([string]$Raw, [string[]]$NonDeterministicPaths)
    $text = $Raw
    $names = @($NonDeterministicPaths | ForEach-Object { ($_ -split '\.')[-1] } | Sort-Object -Unique)
    foreach ($name in $names) {
        $pattern = '"' + [regex]::Escape($name) + '"\s*:\s*("[^"]*"|-?\d+(\.\d+)?)'
        $text = [regex]::Replace($text, $pattern, ('"' + $name + '":"<non-deterministic>"'))
    }
    try { return ($text | ConvertFrom-Json -Depth 20) } catch { return $text }
}

function Get-MaskedText {
    param([string]$Text)
    foreach ($name in @('order_id', 'created_at')) {
        $pattern = '"' + [regex]::Escape($name) + '"\s*:\s*("[^"]*"|-?\d+(\.\d+)?)'
        $Text = [regex]::Replace($Text, $pattern, ('"' + $name + '":"<non-deterministic>"'))
    }
    $Text
}

function Write-StableJson {
    param([Parameter(Mandatory)][string]$Path, [Parameter(Mandatory)]$Object)
    $dir = Split-Path -Parent $Path
    if ($dir -and -not (Test-Path $dir)) { New-Item -ItemType Directory -Force -Path $dir | Out-Null }
    $text = (ConvertTo-Json -InputObject $Object -Depth 30).Replace("`r`n", "`n")
    [IO.File]::WriteAllText($Path, $text + "`n", (New-Object Text.UTF8Encoding($false)))
}