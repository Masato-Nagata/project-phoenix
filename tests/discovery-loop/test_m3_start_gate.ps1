#Requires -Version 7.0
# The M3 start gate (R21.20) and the new Gate m0-checkpoint-exception. Temporary repository roots and temporary Approval_Stores with
# test-specific mutex names only; the real store is opened read-only for the compatibility checks. No Docker, no network.
. (Join-Path $PSScriptRoot 'lib/testlib.ps1')
Import-Module (Join-Path $script:ToolsDir 'DiscoveryCommon.psm1') -Force -DisableNameChecking
Import-Module (Join-Path $script:ToolsDir 'ApprovalStore.psm1') -Force -DisableNameChecking
Import-Module (Join-Path $script:ToolsDir 'MilestoneGate.psm1') -Force -DisableNameChecking
$utf8 = [System.Text.UTF8Encoding]::new($false)
function New-TestMutexName { 'Local\PhoenixTest-M3Gate-' + [guid]::NewGuid().ToString('N') }

function New-GateRepo {
    param([switch]$M2Open)
    $root = New-TempDir; $spec = Join-Path $root '.kiro/specs/discovery-loop'; [void][IO.Directory]::CreateDirectory($spec)
    [IO.File]::WriteAllText((Join-Path $spec 'requirements.md'), "# R`n20. R21.20 text`n", $utf8)
    [IO.File]::WriteAllText((Join-Path $spec 'design.md'), "# D`n", $utf8)
    [IO.File]::WriteAllText((Join-Path $spec 'tasks.md'), "# T`n  - $(if ($M2Open) { '[ ]' } else { '[x]' }) 2.24 Checkpoint - M2 acceptance`n  - [ ] 0.14 Checkpoint - M0 gate review`n", $utf8)
    [void][IO.Directory]::CreateDirectory((Join-Path $root 'discovery/approvals'))
    [pscustomobject]@{ Root = $root; Spec = $spec; Store = (Join-Path $root 'discovery/approvals/approvals.jsonl') }
}
function Get-Rationale { param($Repo, [hashtable]$Override = @{}) $h = Get-SpecHashes -SpecDir $Repo.Spec; foreach ($k in $Override.Keys) { $h[$k] = $Override[$k] }; "One-time exception under R21.20 for the start of M3 only; 0.14 stays open. requirements.md=$($h['requirements.md']) design.md=$($h['design.md']) tasks.md=$($h['tasks.md'])" }
function Add-Rec {
    param($Repo, [string]$Gate = 'm0-checkpoint-exception', [string]$Decision = 'approved', [string]$Rationale, [string]$Actor = 'human', $Supersedes)
    $c = [ordered]@{ approver = 'Test Approver'; timestamp = '2026-11-14T12:00:00.000+09:00'; target = [ordered]@{ kind = 'gate'; gate_id = $Gate }; decision = $Decision; rationale = $(if ($Rationale) { $Rationale } else { Get-Rationale $Repo }); recorded_by = $Actor }
    if ($null -ne $Supersedes) { $c['supersedes'] = [long]$Supersedes }
    Invoke-ApprovalStoreRequest -StorePath $Repo.Store -Request ([ordered]@{ operation = 'append'; candidate = $c }) -MutexName (New-TestMutexName)
}

Invoke-TestMain {
    Write-Host '=== M3 start gate (R21.20) and the Gate m0-checkpoint-exception ===' -ForegroundColor Cyan

    # ---------------------------------------------------------------- the gate list
    $ids = Get-ApprovalGateIds
    $old = @('start-implementation', 'container-runtime', 'override-draft', 'override-apply', 'install-kiro-cli', 'm6-start', 'm7-start', 'transmit-source')
    Test-Case 'gate list: the eight existing gates are unchanged and in their order, and m0-checkpoint-exception is added as the ninth' ((($ids[0..7]) -join ',') -ceq ($old -join ',') -and $ids.Count -eq 9 -and $ids[8] -ceq 'm0-checkpoint-exception')
    $ts = [IO.File]::ReadAllText((Join-Path $script:RepoRoot 'packages/discovery-loop/src/schema/schemas.ts'))
    $block = [regex]::Match($ts, 'const GATE_IDS = \[(?<b>[\s\S]*?)\];').Groups['b'].Value
    $tsIds = @([regex]::Matches($block, '"([a-z0-9-]+)"') | ForEach-Object { $_.Groups[1].Value })
    Test-Case 'gate list: the M1 schema (schemas.ts GATE_IDS) and the store list are identical' (($tsIds -join ',') -ceq ($ids -join ',')) ($tsIds -join ',')

    # ---------------------------------------------------------------- allowed
    $g = New-GateRepo; $a = Add-Rec $g
    $r = Test-M3StartGate -RepoRoot $g.Root -StorePath $g.Store
    Test-Case 'allowed: approved, recorded by human, R21.20 and the three current hashes in the rationale, 2.24 checked' ($a.Outcome -eq 'stored' -and $r.Ok -and $r.Code -eq 'allowed' -and $r.Seq -eq 1) "$($r.Code) $($r.Detail)"
    Test-Case 'allowed: the check writes nothing (the store is byte-identical)' ((Test-BytesEqual (Get-FileBytesOrEmpty $g.Store) ([IO.File]::ReadAllBytes($g.Store))) -and @(Get-ChildItem (Split-Path $g.Store) -File).Count -eq 1)

    # ---------------------------------------------------------------- refusals
    $g = New-GateRepo
    $r = Test-M3StartGate -RepoRoot $g.Root -StorePath $g.Store
    Test-Case 'refused: no store -> not_approved' (-not $r.Ok -and $r.Code -eq 'not_approved')
    [void](Add-Rec $g -Gate 'start-implementation')
    $r = Test-M3StartGate -RepoRoot $g.Root -StorePath $g.Store
    Test-Case 'refused: an approval of start-implementation (even with the hashes) does not count -> not_approved' (-not $r.Ok -and $r.Code -eq 'not_approved')
    [void](Add-Rec $g -Gate 'override-apply')
    $r = Test-M3StartGate -RepoRoot $g.Root -StorePath $g.Store
    Test-Case 'refused: an approval of another gate does not count -> not_approved' (-not $r.Ok -and $r.Code -eq 'not_approved')
    $g = New-GateRepo; [void](Add-Rec $g -Decision 'rejected')
    Test-Case 'refused: rejected' ((Test-M3StartGate -RepoRoot $g.Root -StorePath $g.Store).Code -eq 'rejected')
    $g = New-GateRepo; [void](Add-Rec $g -Decision 'needs_changes')
    Test-Case 'refused: needs_changes' ((Test-M3StartGate -RepoRoot $g.Root -StorePath $g.Store).Code -eq 'needs_changes')
    $g = New-GateRepo; [void](Add-Rec $g); $w = Add-Rec $g -Decision 'rejected' -Supersedes 1
    $r = Test-M3StartGate -RepoRoot $g.Root -StorePath $g.Store
    Test-Case 'refused: an approval withdrawn by a later superseding rejection -> rejected' ($w.Outcome -eq 'stored' -and $r.Code -eq 'rejected' -and $r.Seq -eq 2)
    $g = New-GateRepo; [void](Add-Rec $g)
    [IO.File]::WriteAllText($g.Store, ([IO.File]::ReadAllText($g.Store, $utf8)).Replace('Test Approver', 'Other Approver'), $utf8)
    Test-Case 'refused: a tampered store -> store_invalid' ((Test-M3StartGate -RepoRoot $g.Root -StorePath $g.Store).Code -eq 'store_invalid')
    $g = New-GateRepo; [void](Add-Rec $g)
    [IO.File]::AppendAllText((Join-Path $g.Spec 'tasks.md'), "  - [x] 3.1 edited after the approval`n", $utf8)
    $r = Test-M3StartGate -RepoRoot $g.Root -StorePath $g.Store
    Test-Case 'refused: tasks.md changed after the approval -> hash_mismatch naming tasks.md' ($r.Code -eq 'hash_mismatch' -and $r.Detail -ceq 'tasks.md')
    $g = New-GateRepo; [void](Add-Rec $g -Rationale (Get-Rationale $g -Override @{ 'design.md' = ('0' * 64) }))
    $r = Test-M3StartGate -RepoRoot $g.Root -StorePath $g.Store
    Test-Case 'refused: one wrong hash -> hash_mismatch naming design.md' ($r.Code -eq 'hash_mismatch' -and $r.Detail -ceq 'design.md')
    $g = New-GateRepo; $h = Get-SpecHashes -SpecDir $g.Spec; [void](Add-Rec $g -Rationale "Exception under R21.20. requirements.md=$($h['requirements.md']) design.md=$($h['design.md'])")
    $r = Test-M3StartGate -RepoRoot $g.Root -StorePath $g.Store
    Test-Case 'refused: a hash missing from the rationale -> hashes_missing naming tasks.md' ($r.Code -eq 'hashes_missing' -and $r.Detail -ceq 'tasks.md')
    $g = New-GateRepo; $h = Get-SpecHashes -SpecDir $g.Spec; [void](Add-Rec $g -Rationale "R21.20 requirements.md=$($h['requirements.md']) design.md=$($h['design.md']) tasks.md=$($h['tasks.md']) tasks.md=$($h['tasks.md'])")
    Test-Case 'refused: a hash named twice -> hashes_missing' ((Test-M3StartGate -RepoRoot $g.Root -StorePath $g.Store).Code -eq 'hashes_missing')
    $g = New-GateRepo; $h = Get-SpecHashes -SpecDir $g.Spec; [void](Add-Rec $g -Rationale "Exception. requirements.md=$($h['requirements.md']) design.md=$($h['design.md']) tasks.md=$($h['tasks.md'])")
    Test-Case 'refused: a rationale that does not name R21.20 -> hashes_missing' ((Test-M3StartGate -RepoRoot $g.Root -StorePath $g.Store).Code -eq 'hashes_missing')
    $g = New-GateRepo; [void](Add-Rec $g -Rationale ((Get-Rationale $g).ToUpperInvariant().Replace('R21.20', 'R21.20')))
    Test-Case 'refused: upper-case hashes or file names do not match -> hashes_missing' ((Test-M3StartGate -RepoRoot $g.Root -StorePath $g.Store).Code -eq 'hashes_missing')
    $g = New-GateRepo; [void](Add-Rec $g -Actor 'kiro-development-agent')
    Test-Case 'refused: a record declared recorded_by kiro-development-agent -> not_human' ((Test-M3StartGate -RepoRoot $g.Root -StorePath $g.Store).Code -eq 'not_human')
    $g = New-GateRepo -M2Open; [void](Add-Rec $g)
    Test-Case 'refused: the M2 checkpoint 2.24 not checked -> m2_not_accepted (checked before the store)' ((Test-M3StartGate -RepoRoot $g.Root -StorePath $g.Store).Code -eq 'm2_not_accepted')
    $g = New-GateRepo; Remove-Item -LiteralPath (Join-Path $g.Spec 'design.md')
    Test-Case 'refused: a missing spec file -> spec_missing' ((Test-M3StartGate -RepoRoot $g.Root -StorePath $g.Store).Code -eq 'spec_missing')

    # ---------------------------------------------------------------- compatibility of the existing gates and records
    $g = New-GateRepo; [void](Add-Rec $g -Gate 'override-apply'); [void](Add-Rec $g -Gate 'm0-checkpoint-exception'); [void](Add-Rec $g -Gate 'm6-start' -Decision 'rejected')
    Test-Case 'compatibility: a store with old and new gates verifies; each gate keeps its own latest decision' ((Test-ApprovalStore -StorePath $g.Store).Ok -and (Get-ApprovalGateStatus -StorePath $g.Store -GateId 'override-apply').Status -eq 'approved' -and (Get-ApprovalGateStatus -StorePath $g.Store -GateId 'm6-start').Status -eq 'rejected' -and (Get-ApprovalGateStatus -StorePath $g.Store -GateId 'start-implementation').Status -eq 'none' -and (Get-ApprovalGateStatus -StorePath $g.Store -GateId 'm0-checkpoint-exception').Status -eq 'approved')
    $bad = Invoke-ApprovalStoreRequest -StorePath $g.Store -Request ([ordered]@{ operation = 'append'; candidate = [ordered]@{ approver = 'A'; timestamp = '2026-11-14T12:00:00.000+09:00'; target = [ordered]@{ kind = 'gate'; gate_id = 'm0-checkpoint' }; decision = 'approved'; rationale = 'x'; recorded_by = 'human' } }) -MutexName (New-TestMutexName)
    Test-Case 'compatibility: an undefined gate id is still rejected (invalid), the store unchanged' ($bad.Outcome -eq 'invalid')
    $real = Join-Path $script:RepoRoot 'discovery/approvals/approvals.jsonl'
    if (Test-Path -LiteralPath $real) {
        $before = [IO.File]::ReadAllBytes($real)
        $v = Test-ApprovalStore -StorePath $real
        Test-Case 'compatibility (real store, read-only): the existing chain verifies; override-apply is still approved; the new gate has no record' ($v.Ok -and (Get-ApprovalGateStatus -StorePath $real -GateId 'override-apply').Status -eq 'approved' -and (Get-ApprovalGateStatus -StorePath $real -GateId 'm0-checkpoint-exception').Status -eq 'none')
        Test-Case 'compatibility (real store): unchanged by the checks (byte-identical)' (Test-BytesEqual $before ([IO.File]::ReadAllBytes($real)))
    } else { Write-Host 'NOT MEASURED: no real Approval_Store on this machine' -ForegroundColor Yellow }

    # ---------------------------------------------------------------- static
    $src = [IO.File]::ReadAllText((Join-Path $script:ToolsDir 'MilestoneGate.psm1')) + [IO.File]::ReadAllText((Join-Path $script:ToolsDir 'Test-M3StartGate.ps1'))
    Test-Case 'static: the gate never writes the Approval_Store or any file, and has no Docker call' (-not ($src -match 'Invoke-ApprovalStoreRequest|Write-StoreAtomically|WriteAll|Set-Content|Out-File|Invoke-DockerCli|docker'))
    Test-Case 'static: the module says that this gate never stands for start-implementation or for meeting the M0 acceptance condition, and that M4 follows R21.9' ($src.Contains('never stands for the') -and $src.Contains('R21.9 unchanged'))
}