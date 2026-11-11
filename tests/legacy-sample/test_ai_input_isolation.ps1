#Requires -Version 7.0
# AI input isolation (R9.2, task 4.3 / 4.4). Uses the reference builder in lib/ai-input-builder.ps1.
# What this verifies: the allowlist rule, applied as specified, keeps every non-allowlisted file out of
# the AI input, including canary-marked decoys placed in the Ground Truth, tests, docs, .kiro and inside
# the allowed directories themselves.
# What this does NOT verify: the payload that the real analyzer/spec-restorer sends to ai-client.
# Those packages do not exist yet, so that check is reported as UNVERIFIED.
. (Join-Path $PSScriptRoot 'lib/common.ps1')
. (Join-Path $PSScriptRoot 'lib/ai-input-builder.ps1')

function Write-Text { param([string]$Path, [string]$Text)
    New-Item -ItemType Directory -Force -Path (Split-Path -Parent $Path) | Out-Null
    [IO.File]::WriteAllText($Path, $Text, (New-Object Text.UTF8Encoding($false)))
}

function Test-Throws { param([scriptblock]$Block) try { & $Block | Out-Null; $false } catch { $true } }

$script:Work = Join-Path ([IO.Path]::GetTempPath()) ('phoenix-ai-' + [guid]::NewGuid().ToString('N'))

Invoke-TestMain {
    try {
        $allowPath = Join-Path $script:RepoRoot 'docs/ai-input-allowlist.json'
        $allow = Get-Content -Raw $allowPath | ConvertFrom-Json
        $gtPath = Join-Path $script:RepoRoot 'evaluation/ground-truth/ground-truth.json'
        $gt = Get-Content -Raw $gtPath | ConvertFrom-Json -Depth 40
        $gtCanary = [string]$gt.meta.canary

        # --- real repository ---
        $real = New-AiInputBundle -Root $script:RepoRoot -AllowlistPath $allowPath
        $paths = @($real.Manifest | ForEach-Object { $_.path })
        Test-Case 'AI1 the bundle holds exactly the 7 allowlisted files, in allowlist order' (($paths -join ',') -eq (@($allow.files) -join ',')) ($paths -join ',')
        $markers = @('PHOENIX-GT-CANARY', $gtCanary, 'expected_specification', 'derived_from', 'draft_pending_human_review', 'migration_decision', 'ground-truth', 'SCN-0', 'MD-00', 'DC-00')
        $found = @($markers | Where-Object { $real.Payload.Contains($_) })
        Test-Case 'AI2 the bundle contains no Ground Truth canary and no Ground Truth, decision or defect identifiers' ($found.Count -eq 0) ($found -join ',')
        $res = Get-Content -Raw (Join-Path $script:RepoRoot 'evaluation/results/ground-truth-conformance.json') | ConvertFrom-Json -Depth 40
        $hashMap = @{}; foreach ($s in $res.inputs.legacy_sources) { $hashMap[$s.path] = $s.sha256_lf }
        $hashBad = @($real.Manifest | Where-Object { $hashMap[$_.path] -ne $_.sha256_lf } | ForEach-Object { $_.path })
        Test-Case 'AI3 manifest hashes equal the legacy source hashes recorded by the evaluation baseline' ($hashBad.Count -eq 0) ($hashBad -join ',')

        # --- sandbox with canary decoys ---
        $sb = Join-Path $script:Work 'sandbox'
        foreach ($d in 'legacy/src', 'legacy/sql') { New-Item -ItemType Directory -Force -Path (Join-Path $sb $d) | Out-Null }
        foreach ($f in $allow.files) { Copy-Item -LiteralPath (Join-Path $script:RepoRoot $f) -Destination (Join-Path $sb $f) }
        Copy-Item $allowPath (Join-Path $sb 'ai-input-allowlist.json')
        $run = [guid]::NewGuid().ToString('N')
        $decoys = [ordered]@{
            'evaluation/ground-truth/ground-truth.json' = 'gt'
            'evaluation/migration-decisions.json'       = 'decisions'
            'evaluation/results/ground-truth-conformance.json' = 'results'
            'evaluation/legacy-defect-candidates.md'    = 'defects'
            'evaluation/review/ground-truth-review.md'  = 'review'
            'evaluation/runner/Invoke-GroundTruthEvaluation.ps1' = 'runner'
            'tests/legacy-sample/test_decoy.ps1'        = 'tests'
            'docs/decoy.md'                             = 'docs'
            '.kiro/specs/legacy-sample/requirements.md' = 'kiro-spec'
            '.kiro/steering/decoy.md'                   = 'kiro-steering'
            'README.md'                                 = 'readme'
            'legacy/README.md'                          = 'legacy-readme'
            'legacy/Dockerfile'                         = 'dockerfile'
            '.env'                                      = 'env'
            'legacy/src/notes.md'                       = 'src-notes'
            'legacy/src/.hidden.php'                    = 'src-hidden'
            'legacy/src/extra.php'                      = 'src-extra'
            'legacy/src/sub/deep.php'                   = 'src-deep'
            'legacy/sql/extra.sql'                      = 'sql-extra'
        }
        $canaries = [ordered]@{}
        foreach ($k in $decoys.Keys) {
            $cv = "PHOENIX-AI-DECOY-$($decoys[$k])-$run"
            $canaries[$k] = $cv
            Write-Text (Join-Path $sb $k) "decoy file for AI input isolation test`n$cv`n"
        }
        $box = New-AiInputBundle -Root $sb -AllowlistPath (Join-Path $sb 'ai-input-allowlist.json')
        $leaked = @($canaries.Keys | Where-Object { $box.Payload.Contains($canaries[$_]) })
        Test-Case "AI4 none of the $($canaries.Count) canary decoys reaches the bundle" ($leaked.Count -eq 0) ($leaked -join ',')
        Test-Case 'AI5 the sandbox bundle equals the real bundle (same 7 files, same content)' ($box.Payload -eq $real.Payload)

        # Negative controls: a directory scan would pick the decoys up, so the canaries are detectable.
        $scanAll = (Get-ChildItem -LiteralPath $sb -Recurse -File -Force | ForEach-Object { [IO.File]::ReadAllText($_.FullName) }) -join "`n"
        $seenAll = @($canaries.Keys | Where-Object { $scanAll.Contains($canaries[$_]) })
        Test-Case 'AI6 control: a naive recursive scan of the project root picks up every canary' ($seenAll.Count -eq $canaries.Count) "$($seenAll.Count)/$($canaries.Count)"
        $scanSrc = (Get-ChildItem -LiteralPath (Join-Path $sb 'legacy') -Recurse -File -Force | ForEach-Object { [IO.File]::ReadAllText($_.FullName) }) -join "`n"
        $inDir = @('legacy/src/notes.md', 'legacy/src/.hidden.php', 'legacy/src/extra.php', 'legacy/src/sub/deep.php', 'legacy/sql/extra.sql', 'legacy/README.md', 'legacy/Dockerfile')
        $seenSrc = @($inDir | Where-Object { $scanSrc.Contains($canaries[$_]) })
        Test-Case 'AI7 control: even a scan limited to legacy/ picks up the decoys placed next to allowed files' ($seenSrc.Count -eq $inDir.Count) "$($seenSrc.Count)/$($inDir.Count)"

        # --- fail closed on bad entries ---
        $gtAbs = (Join-Path $sb 'evaluation/ground-truth/ground-truth.json').Replace('\', '/')
        $bad = @(
            '../evaluation/ground-truth/ground-truth.json',
            'legacy/src/../../evaluation/ground-truth/ground-truth.json',
            'evaluation/ground-truth/ground-truth.json',
            $gtAbs,
            '/etc/passwd',
            'legacy/src/*.php',
            'legacy/src/index.ph?',
            'legacy/src',
            'legacy/src/',
            'legacy/src/sub/deep.php',
            'legacy\src\index.php',
            './legacy/src/index.php',
            'legacy/src/./index.php',
            'legacy/src/index.php ',
            'legacy/src/missing.php',
            'legacy/src/notes.md',
            'legacy/Dockerfile',
            'legacy/src/index.php'
        )
        $accepted = New-Object System.Collections.Generic.List[string]
        foreach ($e in $bad) {
            $list = [ordered]@{ files = @(@($allow.files) + $e) }
            $lp = Join-Path $script:Work 'bad-allowlist.json'
            Write-Text $lp (ConvertTo-Json $list -Depth 5)
            if (-not (Test-Throws { New-AiInputBundle -Root $sb -AllowlistPath $lp })) { $accepted.Add($e) }
        }
        Test-Case "AI8 the builder fails closed on all $($bad.Count) bad entries (traversal, absolute, wildcard, directory, nested, backslash, missing, non-source, duplicate)" ($accepted.Count -eq 0) ($accepted -join ' | ')
        $empty = Join-Path $script:Work 'empty-allowlist.json'
        Write-Text $empty '{ "files": [] }'
        Test-Case 'AI9 an empty allowlist is rejected instead of meaning "everything"' (Test-Throws { New-AiInputBundle -Root $sb -AllowlistPath $empty })

        # Junction: legacy/sql is replaced by a junction that points at a directory holding decoy SQL.
        $sb2 = Join-Path $script:Work 'sandbox-junction'
        New-Item -ItemType Directory -Force -Path (Join-Path $sb2 'legacy/src') | Out-Null
        foreach ($f in @($allow.files | Where-Object { $_ -like 'legacy/src/*' })) { Copy-Item -LiteralPath (Join-Path $script:RepoRoot $f) -Destination (Join-Path $sb2 $f) }
        $target = Join-Path $sb2 'evaluation/ground-truth'
        foreach ($n in 'schema.sql', 'seed.sql') { Write-Text (Join-Path $target $n) "-- PHOENIX-AI-DECOY-junction-$run`n" }
        $junctionMade = $true
        try { New-Item -ItemType Junction -Path (Join-Path $sb2 'legacy/sql') -Target $target | Out-Null } catch { $junctionMade = $false }
        if ($junctionMade) {
            Test-Case 'AI10 an allowlisted path that passes through a junction is rejected' (Test-Throws { New-AiInputBundle -Root $sb2 -AllowlistPath $allowPath })
        } else {
            Test-Case 'AI10 junction could be created for the reparse-point check' $false 'New-Item -ItemType Junction failed on this host'
        }

        # --- repository-wide canary placement ---
        $skip = '\\(\.git|node_modules)\\'
        $holders = @(Get-ChildItem -LiteralPath $script:RepoRoot -Recurse -File -Force | Where-Object { $_.FullName -notmatch $skip -and $_.Length -lt 5MB } | Where-Object { [IO.File]::ReadAllText($_.FullName).Contains($gtCanary) } | ForEach-Object { $_.FullName.Substring($script:RepoRoot.Length).TrimStart('\', '/').Replace('\', '/') })
        Test-Case 'AI11 the Ground Truth canary value appears only in evaluation/ground-truth/ground-truth.json' (($holders -join ',') -eq 'evaluation/ground-truth/ground-truth.json') ($holders -join ',')

        Write-Host 'UNVERIFIED: the payload actually sent by the analyzer/spec-restorer to ai-client is not verified. Those packages are not implemented; AI1-AI11 verify the allowlist rule with a reference builder only.' -ForegroundColor Yellow
    } finally {
        $j = Join-Path $script:Work 'sandbox-junction/legacy/sql'
        if (Test-Path -LiteralPath $j) { (Get-Item -LiteralPath $j -Force).Delete() }
        Remove-Item -LiteralPath $script:Work -Recurse -Force -ErrorAction SilentlyContinue
    }
}