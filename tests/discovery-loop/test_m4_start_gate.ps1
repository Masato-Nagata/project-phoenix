#Requires -Version 7.0
# The M4 start gate (R21.21) and the new Gate m4-start-exception. Temporary repository roots and temporary Approval_Stores with
# test-specific mutex names only; the real store is opened read-only for the compatibility checks, and the gate is never run against
# the real repository. The ancestor check is replaced by a stub except in the explicit git checks (read-only `git merge-base`).
# No Docker, no network.
. (Join-Path $PSScriptRoot 'lib/testlib.ps1')
Import-Module (Join-Path $script:ToolsDir 'DiscoveryCommon.psm1') -Force -DisableNameChecking
Import-Module (Join-Path $script:ToolsDir 'ApprovalStore.psm1') -Force -DisableNameChecking
Import-Module (Join-Path $script:ToolsDir 'MilestoneGate.psm1') -Force -DisableNameChecking
$utf8 = [System.Text.UTF8Encoding]::new($false)
$script:M3Commit = '0d695ed567ca9c02e59def2e3b28bbe9af7d3772'
$yes = { param($r, $c) $true }
$no = { param($r, $c) $false }
function New-TestMutexName { 'Local\PhoenixTest-M4Gate-' + [guid]::NewGuid().ToString('N') }

function New-GateRepo {
    param([switch]$M3Open)
    $root = New-TempDir; $spec = Join-Path $root '.kiro/specs/discovery-loop'; [void][IO.Directory]::CreateDirectory($spec)
    [IO.File]::WriteAllText((Join-Path $spec 'requirements.md'), "# R`n21. R21.21 text`n", $utf8)
    [IO.File]::WriteAllText((Join-Path $spec 'design.md'), "# D`n", $utf8)
    [IO.File]::WriteAllText((Join-Path $spec 'tasks.md'), "# T`n  - $(if ($M3Open) { '[ ]' } else { '[x]' }) 3.12 Checkpoint - M3 acceptance`n  - [ ] 0.13 override`n  - [ ] 0.14 Checkpoint - M0 gate review`n", $utf8)
    [void][IO.Directory]::CreateDirectory((Join-Path $root 'infra')); [void][IO.Directory]::CreateDirectory((Join-Path $root 'discovery/approvals'))
    [IO.File]::WriteAllText((Join-Path $root 'infra/docker-compose.discovery.yml'), "networks:`n  test-lab:`n    internal: true`n", $utf8)
    [pscustomobject]@{ Root = $root; Spec = $spec; Override = (Join-Path $root 'infra/docker-compose.discovery.yml'); Store = (Join-Path $root 'discovery/approvals/approvals.jsonl') }
}
function Get-M4Rationale {
    param($Repo, [hashtable]$Override = @{}, [string]$Commit = $script:M3Commit, [switch]$NoCommit, [switch]$NoR2121)
    $h = Get-SpecHashes -SpecDir $Repo.Spec; foreach ($k in $Override.Keys) { $h[$k] = $Override[$k] }
    $r = $(if ($NoR2121) { 'Exception for the start of M4 only.' } else { 'One-time exception under R21.21 for the start of M4 only; 0.13 and 0.14 stay open; not retroactive.' })
    if (-not $NoCommit) { $r += " m3-commit=$Commit" }
    "$r requirements.md=$($h['requirements.md']) design.md=$($h['design.md']) tasks.md=$($h['tasks.md'])"
}
function Add-Rec {
    param($Repo, [string]$Gate = 'm4-start-exception', [string]$Decision = 'approved', [string]$Rationale, [string]$Actor = 'human', $Supersedes)
    $c = [ordered]@{ approver = 'Test Approver'; timestamp = '2026-11-15T12:00:00.000+09:00'; target = [ordered]@{ kind = 'gate'; gate_id = $Gate }; decision = $Decision; rationale = $(if ($Rationale) { $Rationale } else { Get-M4Rationale $Repo }); recorded_by = $Actor }
    if ($null -ne $Supersedes) { $c['supersedes'] = [long]$Supersedes }
    Invoke-ApprovalStoreRequest -StorePath $Repo.Store -Request ([ordered]@{ operation = 'append'; candidate = $c }) -MutexName (New-TestMutexName)
}
function Add-OverrideRec {
    param($Repo, [string]$Hash, [string]$Decision = 'approved', [string]$Actor = 'human', $Supersedes, [string]$Rationale)
    if (-not $Hash) { $Hash = Get-Sha256HexOfFile -Path $Repo.Override }
    Add-Rec $Repo -Gate 'override-apply' -Decision $Decision -Actor $Actor -Supersedes $Supersedes -Rationale $(if ($Rationale) { $Rationale } else { "Approved discovery override SHA-256: $Hash. Authorize creation of the lab network." })
}
function New-ReadyRepo { $g = New-GateRepo; [void](Add-OverrideRec $g); [void](Add-Rec $g); $g }
function Gate { param($g, [string]$M = 'M4', [scriptblock]$Anc = $yes) Test-M4StartGate -RepoRoot $g.Root -StorePath $g.Store -TargetMilestone $M -IsAncestor $Anc }

Invoke-TestMain {
    Write-Host '=== M4 start gate (R21.21) and the Gate m4-start-exception ===' -ForegroundColor Cyan

    # ---------------------------------------------------------------- the gate list
    $ids = Get-ApprovalGateIds
    $old = @('start-implementation', 'container-runtime', 'override-draft', 'override-apply', 'install-kiro-cli', 'm6-start', 'm7-start', 'transmit-source', 'm0-checkpoint-exception')
    Test-Case 'gate list: the nine existing gates are unchanged and in their order, and m4-start-exception is the tenth' ((($ids[0..8]) -join ',') -ceq ($old -join ',') -and $ids.Count -eq 10 -and $ids[9] -ceq 'm4-start-exception')
    $ts = [IO.File]::ReadAllText((Join-Path $script:RepoRoot 'packages/discovery-loop/src/schema/schemas.ts'))
    $block = [regex]::Match($ts, 'const GATE_IDS = \[(?<b>[\s\S]*?)\];').Groups['b'].Value
    $tsIds = @([regex]::Matches($block, '"([a-z0-9-]+)"') | ForEach-Object { $_.Groups[1].Value })
    Test-Case 'gate list: the M1 schema (schemas.ts GATE_IDS) and the store list are identical' (($tsIds -join ',') -ceq ($ids -join ',')) ($tsIds -join ',')

    # ---------------------------------------------------------------- allowed
    $g = New-ReadyRepo
    $before = [IO.File]::ReadAllBytes($g.Store); $files = @(Get-ChildItem $g.Root -Recurse -File).Count
    $seen = @{ commit = $null }
    $r = Test-M4StartGate -RepoRoot $g.Root -StorePath $g.Store -IsAncestor { param($root, $c) $seen.commit = $c; $true }
    Test-Case 'allowed: M3 accepted, commit is an ancestor, approved by human, R21.21 + commit + three hashes, override-apply approved with the current override hash' ($r.Ok -and $r.Code -eq 'allowed' -and $r.Seq -eq 2) "$($r.Code) $($r.Detail)"
    Test-Case 'allowed: the ancestor check receives exactly the M3 commit of R21.21' ($seen.commit -ceq $script:M3Commit)
    Test-Case 'allowed: the check writes nothing (the store and the file count are unchanged)' ((Test-BytesEqual $before ([IO.File]::ReadAllBytes($g.Store))) -and @(Get-ChildItem $g.Root -Recurse -File).Count -eq $files)
    Test-Case 'allowed: the result states that 0.13 and 0.14 stay open and that M5 and later follow R21.9' ($r.Detail.Contains('0.14') -and $r.Detail.Contains('0.13') -and $r.Detail.Contains('R21.9'))

    # ---------------------------------------------------------------- refusals: the approval record
    $g = New-GateRepo; [void](Add-OverrideRec $g)
    Test-Case 'refused: no store -> not_approved' ((Gate (New-GateRepo)).Code -eq 'not_approved')
    $r = Gate $g
    Test-Case 'refused: a store without a record of the gate -> not_approved' (-not $r.Ok -and $r.Code -eq 'not_approved')
    [void](Add-Rec $g -Gate 'm0-checkpoint-exception' -Rationale ((Get-M4Rationale $g).Replace('R21.21', 'R21.20')))
    Test-Case 'refused: the approval of m0-checkpoint-exception (the M3 start) does not count -> not_approved' ((Gate $g).Code -eq 'not_approved')
    [void](Add-Rec $g -Gate 'start-implementation')
    Test-Case 'refused: an approval of start-implementation does not count -> not_approved' ((Gate $g).Code -eq 'not_approved')
    $bad = Add-Rec $g -Gate 'm4-start-exceptions'
    Test-Case 'invalid gate id: a near-miss id is rejected by the store (invalid) and the gate stays not_approved' ($bad.Outcome -eq 'invalid' -and (Gate $g).Code -eq 'not_approved')
    $bad2 = Add-Rec $g -Gate 'M4-START-EXCEPTION'
    Test-Case 'invalid gate id: an upper-case id is rejected by the store (invalid)' ($bad2.Outcome -eq 'invalid')
    $g = New-GateRepo; [void](Add-OverrideRec $g); [void](Add-Rec $g -Decision 'rejected')
    Test-Case 'refused: decision rejected' ((Gate $g).Code -eq 'rejected')
    $g = New-GateRepo; [void](Add-OverrideRec $g); [void](Add-Rec $g -Decision 'needs_changes')
    Test-Case 'refused: decision needs_changes' ((Gate $g).Code -eq 'needs_changes')
    $g = New-ReadyRepo; $w = Add-Rec $g -Decision 'rejected' -Supersedes 2
    $r = Gate $g
    Test-Case 'refused: an approval withdrawn by a later superseding rejection -> rejected' ($w.Outcome -eq 'stored' -and $r.Code -eq 'rejected' -and $r.Seq -eq 3)
    $g = New-GateRepo; [void](Add-OverrideRec $g); [void](Add-Rec $g -Actor 'kiro-development-agent')
    Test-Case 'refused: recorded_by kiro-development-agent -> not_human' ((Gate $g).Code -eq 'not_human')

    # ---------------------------------------------------------------- refusals: the hashes and the commit
    $g = New-GateRepo; [void](Add-OverrideRec $g); [void](Add-Rec $g -Rationale (Get-M4Rationale $g -Override @{ 'design.md' = ('0' * 64) }))
    $r = Gate $g
    Test-Case 'refused: one wrong approved hash -> hash_mismatch naming design.md' ($r.Code -eq 'hash_mismatch' -and $r.Detail -ceq 'design.md')
    $g = New-ReadyRepo
    [IO.File]::AppendAllText((Join-Path $g.Spec 'tasks.md'), "  - [x] 4.1 edited after the approval`n", $utf8)
    $r = Gate $g
    Test-Case 'refused: tasks.md changed after the approval -> hash_mismatch naming tasks.md (re-evaluation and a new record are needed)' ($r.Code -eq 'hash_mismatch' -and $r.Detail -ceq 'tasks.md')
    $g = New-ReadyRepo
    [IO.File]::AppendAllText((Join-Path $g.Spec 'requirements.md'), "x`n", $utf8)
    Test-Case 'refused: requirements.md changed after the approval -> hash_mismatch naming requirements.md' ((Gate $g).Detail -ceq 'requirements.md')
    $g = New-GateRepo; [void](Add-OverrideRec $g); $h = Get-SpecHashes -SpecDir $g.Spec; [void](Add-Rec $g -Rationale "R21.21 m3-commit=$($script:M3Commit) requirements.md=$($h['requirements.md']) design.md=$($h['design.md'])")
    $r = Gate $g
    Test-Case 'refused: a hash missing from the rationale -> hashes_missing naming tasks.md' ($r.Code -eq 'hashes_missing' -and $r.Detail -ceq 'tasks.md')
    $g = New-GateRepo; [void](Add-OverrideRec $g); [void](Add-Rec $g -Rationale ((Get-M4Rationale $g) + " tasks.md=$((Get-SpecHashes -SpecDir $g.Spec)['tasks.md'])"))
    Test-Case 'refused: a hash named twice -> hashes_missing' ((Gate $g).Code -eq 'hashes_missing')
    $g = New-GateRepo; [void](Add-OverrideRec $g); [void](Add-Rec $g -Rationale (Get-M4Rationale $g -NoR2121))
    Test-Case 'refused: a rationale that does not name R21.21 (R21.20 is not enough) -> hashes_missing' ((Gate $g).Code -eq 'hashes_missing')
    $g = New-GateRepo; [void](Add-OverrideRec $g); [void](Add-Rec $g -Rationale ([regex]::Replace((Get-M4Rationale $g), '=([0-9a-f]{64})', { param($m) '=' + $m.Groups[1].Value.ToUpperInvariant() })))
    Test-Case 'refused: upper-case hashes do not match -> hashes_missing' ((Gate $g).Code -eq 'hashes_missing')
    $g = New-GateRepo; [void](Add-OverrideRec $g); [void](Add-Rec $g -Rationale ((Get-M4Rationale $g).ToUpperInvariant()))
    Test-Case 'refused: a fully upper-case rationale is not accepted (the commit is not recognized) -> commit_missing' ((Gate $g).Code -eq 'commit_missing')
    $g = New-GateRepo; [void](Add-OverrideRec $g); [void](Add-Rec $g -Rationale (Get-M4Rationale $g -NoCommit))
    Test-Case 'refused: the rationale does not name the M3 commit -> commit_missing' ((Gate $g).Code -eq 'commit_missing')
    $g = New-GateRepo; [void](Add-OverrideRec $g); [void](Add-Rec $g -Rationale ((Get-M4Rationale $g) + " m3-commit=$($script:M3Commit)"))
    Test-Case 'refused: the M3 commit named twice -> commit_missing' ((Gate $g).Code -eq 'commit_missing')
    $g = New-GateRepo; [void](Add-OverrideRec $g); [void](Add-Rec $g -Rationale (Get-M4Rationale $g -Commit ('a' * 40)))
    Test-Case 'refused: another commit named in the rationale -> commit_mismatch' ((Gate $g).Code -eq 'commit_mismatch')

    # ---------------------------------------------------------------- refusals: M3, the commit, the store, the spec
    $g = New-ReadyRepo
    $r = Gate $g -Anc $no
    Test-Case 'refused: the M3 commit is not an ancestor (valid record otherwise) -> m3_commit_not_ancestor' (-not $r.Ok -and $r.Code -eq 'm3_commit_not_ancestor')
    $g = New-GateRepo; $r = Test-M4StartGate -RepoRoot $g.Root -StorePath $g.Store
    Test-Case 'refused: without the stub, a directory that is not a repository containing the M3 commit -> m3_commit_not_ancestor' ($r.Code -eq 'm3_commit_not_ancestor')
    $g = New-GateRepo -M3Open; [void](Add-OverrideRec $g); [void](Add-Rec $g)
    Test-Case 'refused: task 3.12 not checked -> m3_not_accepted (checked before the commit and the store)' ((Gate $g -Anc $no).Code -eq 'm3_not_accepted')
    $g = New-ReadyRepo; [IO.File]::WriteAllText($g.Store, ([IO.File]::ReadAllText($g.Store, $utf8)).Replace('Test Approver', 'Other Approver'), $utf8)
    Test-Case 'refused: a tampered Approval_Store -> store_invalid' ((Gate $g).Code -eq 'store_invalid')
    $g = New-ReadyRepo; $lines = @([IO.File]::ReadAllLines($g.Store)); [IO.File]::WriteAllText($g.Store, ($lines[1] + "`n"), $utf8)
    Test-Case 'refused: a store with a removed first record (broken chain) -> store_invalid' ((Gate $g).Code -eq 'store_invalid')
    $g = New-ReadyRepo; Remove-Item -LiteralPath (Join-Path $g.Spec 'design.md')
    Test-Case 'refused: a missing spec file -> spec_missing' ((Gate $g).Code -eq 'spec_missing')

    # ---------------------------------------------------------------- refusals: override-apply
    $g = New-GateRepo; [void](Add-Rec $g)
    Test-Case 'refused: no override-apply record -> override_not_approved' ((Gate $g).Code -eq 'override_not_approved')
    $g = New-GateRepo; [void](Add-OverrideRec $g -Decision 'rejected'); [void](Add-Rec $g)
    Test-Case 'refused: override-apply rejected -> override_not_approved' ((Gate $g).Code -eq 'override_not_approved')
    $g = New-GateRepo; [void](Add-OverrideRec $g -Decision 'needs_changes'); [void](Add-Rec $g)
    Test-Case 'refused: override-apply needs_changes -> override_not_approved' ((Gate $g).Code -eq 'override_not_approved')
    $g = New-GateRepo; [void](Add-OverrideRec $g); [void](Add-OverrideRec $g -Decision 'rejected' -Supersedes 1); [void](Add-Rec $g)
    Test-Case 'refused: override-apply withdrawn by a later superseding rejection -> override_not_approved' ((Gate $g).Code -eq 'override_not_approved')
    $g = New-GateRepo; [void](Add-OverrideRec $g -Actor 'kiro-development-agent'); [void](Add-Rec $g)
    Test-Case 'refused: override-apply declared recorded_by kiro-development-agent -> override_not_approved' ((Gate $g).Code -eq 'override_not_approved')
    $g = New-GateRepo; [void](Add-OverrideRec $g -Hash ('1' * 64)); [void](Add-Rec $g)
    $r = Gate $g
    Test-Case 'refused: the approved override hash differs from the current file -> override_hash_mismatch' ($r.Code -eq 'override_hash_mismatch')
    $g = New-ReadyRepo; [IO.File]::AppendAllText($g.Override, "# changed after the approval`n", $utf8)
    Test-Case 'refused: the override file changed after the approval -> override_hash_mismatch' ((Gate $g).Code -eq 'override_hash_mismatch')
    $g = New-GateRepo; [void](Add-OverrideRec $g -Rationale 'Approved without a hash.'); [void](Add-Rec $g)
    Test-Case 'refused: the override-apply rationale names no SHA-256 -> override_hash_missing' ((Gate $g).Code -eq 'override_hash_missing')
    $g = New-GateRepo; $oh = Get-Sha256HexOfFile -Path $g.Override; [void](Add-OverrideRec $g -Rationale "Approved $oh and also $('2' * 64)."); [void](Add-Rec $g)
    Test-Case 'refused: the override-apply rationale names two different SHA-256 values -> override_hash_missing (ambiguous)' ((Gate $g).Code -eq 'override_hash_missing')
    $g = New-GateRepo; $oh = Get-Sha256HexOfFile -Path $g.Override; [void](Add-OverrideRec $g -Rationale "Approved $($oh.ToUpperInvariant())."); [void](Add-Rec $g)
    Test-Case 'refused: an upper-case override hash does not count -> override_hash_missing' ((Gate $g).Code -eq 'override_hash_missing')
    $g = New-ReadyRepo; Remove-Item -LiteralPath $g.Override
    Test-Case 'refused: the override file is missing -> override_missing' ((Gate $g).Code -eq 'override_missing')

    # ---------------------------------------------------------------- the exception is not carried over to M5 or later
    $g = New-ReadyRepo
    foreach ($m in @('M5', 'M6', 'M7', 'M3', 'm4', 'M4 ', '')) {
        $r = Gate $g -M $m
        Test-Case "not carried over: a valid record used for target milestone '$m' -> exception_not_applicable" (-not $r.Ok -and $r.Code -eq 'exception_not_applicable')
    }
    Test-Case 'not carried over: the same repository is allowed for M4 (positive control)' ((Gate $g -M 'M4').Ok)
    $g2 = New-GateRepo -M3Open
    Test-Case 'not carried over: the target milestone is checked before everything else' ((Gate $g2 -M 'M5' -Anc $no).Code -eq 'exception_not_applicable')

    # ---------------------------------------------------------------- real git (read-only) and the real store (read-only)
    $mod = Get-Module MilestoneGate
    $isAnc = & $mod { param($root, $c) Test-CommitIsAncestorOfHead -RepoRoot $root -Commit $c } $script:RepoRoot $script:M3Commit
    $notAnc = & $mod { param($root, $c) Test-CommitIsAncestorOfHead -RepoRoot $root -Commit $c } $script:RepoRoot ('f' * 40)
    Test-Case 'git (read-only): the M3 commit 0d695ed is an ancestor of the checked-out commit of this repository' ($isAnc -eq $true)
    Test-Case 'git (read-only): a commit that does not exist is not an ancestor' ($notAnc -eq $false)
    $real = Join-Path $script:RepoRoot 'discovery/approvals/approvals.jsonl'
    if (Test-Path -LiteralPath $real) {
        $rb = [IO.File]::ReadAllBytes($real)
        $v = Test-ApprovalStore -StorePath $real
        Test-Case 'compatibility (real store, read-only): the existing chain verifies with the ten-gate list; override-apply and m0-checkpoint-exception are still approved; the new gate has no record' ($v.Ok -and (Get-ApprovalGateStatus -StorePath $real -GateId 'override-apply').Status -eq 'approved' -and (Get-ApprovalGateStatus -StorePath $real -GateId 'm0-checkpoint-exception').Status -eq 'approved' -and (Get-ApprovalGateStatus -StorePath $real -GateId 'm4-start-exception').Status -eq 'none')
        $ov = Get-ApprovalStoreAnalysis -Bytes $rb
        $seq1 = $null; foreach ($l in $ov.Approvals.Values) { if ([long]$l['seq'] -eq 1) { $seq1 = $l } }
        $realOverride = Join-Path $script:RepoRoot 'infra/docker-compose.discovery.yml'
        Test-Case 'compatibility (real store): the override hash named in seq 1 equals the current override file (a fact check, nothing applied)' ($null -ne $seq1 -and ([string]$seq1['rationale']).Contains((Get-Sha256HexOfFile -Path $realOverride)))
        Test-Case 'compatibility (real store): unchanged by the checks (byte-identical)' (Test-BytesEqual $rb ([IO.File]::ReadAllBytes($real)))
    } else { Write-Host 'NOT MEASURED: no real Approval_Store on this machine' -ForegroundColor Yellow }

    # ---------------------------------------------------------------- static
    $src = [IO.File]::ReadAllText((Join-Path $script:ToolsDir 'MilestoneGate.psm1')) + [IO.File]::ReadAllText((Join-Path $script:ToolsDir 'Test-M4StartGate.ps1'))
    $stripped = $src.Replace('docker-compose.discovery.yml', '')
    Test-Case 'static: the gate never writes the Approval_Store or any file, and has no Docker call' (-not ($stripped -match 'Invoke-ApprovalStoreRequest|Write-StoreAtomically|WriteAll|Set-Content|Out-File|Invoke-DockerCli|docker'))
    Test-Case 'static: the only external command is the read-only git merge-base --is-ancestor' (([regex]::Matches($stripped, '&\s+git\s+[^\r\n]*')).Count -eq 1 -and $stripped.Contains('merge-base --is-ancestor') -and -not ($stripped -match '\bgit\s+(commit|push|merge |add|reset|checkout|config|rebase)'))
    Test-Case 'static: the module says that the M4 gate never stands for the start instruction and for meeting the M0 acceptance condition, never closes 0.13 and 0.14, and is never carried over' ($src.Contains('never stands for the start instruction of R21.19') -and $src.Contains('never meets the M0 acceptance condition') -and $src.Contains('the tasks 0.13 and 0.14') -and $src.Contains('never carried over'))
}
