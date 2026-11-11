#Requires -Version 7.0
# Reproducibility of the Ground Truth evaluation: two runs, each starting from the initial state,
# must produce byte-identical results, equal to the committed baseline. Raw (unmasked) evidence is
# written as well, to show that the masking hides real non-deterministic values instead of the values
# simply being absent.
. (Join-Path $PSScriptRoot 'lib/common.ps1')
. (Join-Path $script:RepoRoot 'evaluation/runner/EvalCommon.ps1')

$script:Runner = Join-Path $script:RepoRoot 'evaluation/runner/Invoke-GroundTruthEvaluation.ps1'
$script:Baseline = Join-Path $script:RepoRoot 'evaluation/results/ground-truth-conformance.json'
$script:Work = Join-Path ([IO.Path]::GetTempPath()) ('phoenix-gtr-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $script:Work | Out-Null

function Invoke-Run { param([string]$Name)
    $out = Join-Path $script:Work "$Name.json"; $raw = Join-Path $script:Work "$Name.raw.json"
    & pwsh -NoProfile -NonInteractive -File $script:Runner -BaseUrl $script:BaseUrl -OutputPath $out -RawOutputPath $raw *> (Join-Path $script:Work "$Name.log")
    [pscustomobject]@{ Code = $LASTEXITCODE; Out = $out; Raw = $raw }
}

Invoke-TestMain {
    try {
        $a = Invoke-Run 'run1'
        # Make the second run fall in a different second at least, so masked timestamps really differ underneath.
        Start-Sleep -Seconds 2
        $b = Invoke-Run 'run2'
        Test-Case 'GR1 both runs complete with exit 0' ($a.Code -eq 0 -and $b.Code -eq 0) "codes=$($a.Code),$($b.Code)"
        $ha = (Get-FileHash $a.Out -Algorithm SHA256).Hash; $hb = (Get-FileHash $b.Out -Algorithm SHA256).Hash
        Test-Case 'GR2 the two result files are byte-identical' ($ha -eq $hb) "$ha / $hb"
        $hBase = (Get-FileHash $script:Baseline -Algorithm SHA256).Hash
        Test-Case 'GR3 the result equals the committed baseline evaluation/results/ground-truth-conformance.json' ($ha -eq $hBase) "$ha / $hBase"

        $text = Get-Content -Raw $a.Out
        $iso = [regex]::Matches($text, '\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}').Count
        Test-Case 'GR4 the result contains no wall-clock timestamp' ($iso -eq 0) "found=$iso"
        $unmaskedId = [regex]::Matches($text, '"order_id"\s*:\s*\d').Count
        Test-Case 'GR5 order ids and created_at are masked as <non-deterministic>' ($unmaskedId -eq 0 -and $text.Contains('"order_id": "<non-deterministic>"') -and $text.Contains('"created_at": "<non-deterministic>"')) "unmasked=$unmaskedId"

        $raw1 = Get-Content -Raw $a.Raw; $raw2 = Get-Content -Raw $b.Raw
        $rawStamps = [regex]::Matches($raw1, '\\"created_at\\":\\"\d{4}-\d{2}-\d{2}T').Count
        Test-Case 'GR6 the raw evidence holds the real created_at values that the result masks' ($rawStamps -gt 0) "found=$rawStamps"
        Test-Case 'GR7 the raw evidence differs between runs (time moved) while the masked results do not' ($raw1 -ne $raw2 -and $ha -eq $hb)

        $j = $text | ConvertFrom-Json -Depth 40
        $okInputs = ($j.inputs.ground_truth.sha256_lf -eq (Get-Sha256Lf (Join-Path $script:RepoRoot 'evaluation/ground-truth/ground-truth.json'))) -and ($j.inputs.migration_decisions.sha256_lf -eq (Get-Sha256Lf (Join-Path $script:RepoRoot 'evaluation/migration-decisions.json')))
        $badSrc = @($j.inputs.legacy_sources | Where-Object { $_.sha256_lf -ne (Get-Sha256Lf (Join-Path $script:RepoRoot $_.path)) } | ForEach-Object { $_.path })
        Test-Case 'GR8 the result records the current hashes of the Ground Truth, the registry and the 7 legacy files' ($okInputs -and $badSrc.Count -eq 0 -and @($j.inputs.legacy_sources).Count -eq 7) ($badSrc -join ',')

        # Each unit starts from the initial state: the runner resets before each unit, so a seed
        # snapshot taken after the run equals the seed (the runner also resets at the end).
        $p = Invoke-Api -Method GET -Path '/products'
        $seed = Read-SeedSql
        $same = (@($p.Body.data | ForEach-Object { "$($_.id):$($_.stock_quantity)" }) -join ',') -eq (@($seed.Products | ForEach-Object { "$($_.id):$($_.stock_quantity)" }) -join ',')
        $o = Invoke-Api -Method GET -Path '/orders'
        Test-Case 'GR9 after the run the app is back in the initial state (seed stock, no orders, no fixture product)' ($same -and @($o.Body.data).Count -eq 0) ("products=" + @($p.Body.data).Count)
    } finally {
        Remove-Item -LiteralPath $script:Work -Recurse -Force -ErrorAction SilentlyContinue
    }
}