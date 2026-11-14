# Small test library for tests/discovery-loop (plain PowerShell 7, no external module; same style as tests/legacy-sample).
# Every test works on a temporary directory it creates and removes. None of them touches discovery/approvals/, discovery/runs/,
# the real conformance mutex, a real Docker daemon, or the network.
$ProgressPreference = 'SilentlyContinue'
$ErrorActionPreference = 'Stop'
$script:RepoRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../../..'))
$script:ToolsDir = Join-Path $script:RepoRoot 'discovery/tools'
$script:PassCount = 0
$script:FailCount = 0
$script:TempDirs = [System.Collections.Generic.List[string]]::new()

function Test-Case {
    param([Parameter(Mandatory)][string]$Name, [Parameter(Mandatory)][bool]$Condition, [string]$Detail = '')
    if ($Condition) { Write-Host "PASS: $Name" -ForegroundColor Green; $script:PassCount++ }
    else {
        $msg = "FAIL: $Name"
        if ($Detail) { $msg += "  ($Detail)" }
        Write-Host $msg -ForegroundColor Red
        $script:FailCount++
    }
}

function Test-Throws {
    param([Parameter(Mandatory)][string]$Name, [Parameter(Mandatory)][scriptblock]$Script, [string]$Like = '*')
    $threw = $false; $msg = ''
    try { & $Script | Out-Null } catch { $threw = $true; $msg = $_.Exception.Message }
    Test-Case $Name ($threw -and $msg -like $Like) "threw=$threw message='$msg'"
}

function New-TempDir {
    $p = Join-Path ([IO.Path]::GetTempPath()) ('phx-test-' + [guid]::NewGuid().ToString('N'))
    [void][IO.Directory]::CreateDirectory($p)
    $script:TempDirs.Add($p)
    $p
}

function Remove-TempDirs {
    foreach ($d in $script:TempDirs) { try { if (Test-Path -LiteralPath $d) { Remove-Item -LiteralPath $d -Recurse -Force -ErrorAction SilentlyContinue } } catch { } }
    $script:TempDirs.Clear()
}

# Starts a child pwsh process on a script file and returns its exit code, standard output, and standard error.
function Invoke-ChildPwsh {
    param([Parameter(Mandatory)][string]$ScriptPath, [string[]]$Arguments = @(), [int]$TimeoutSec = 120)
    $psi = [System.Diagnostics.ProcessStartInfo]::new((Get-Process -Id $PID).Path)
    foreach ($a in @('-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', $ScriptPath) + $Arguments) { $psi.ArgumentList.Add($a) }
    $psi.RedirectStandardOutput = $true; $psi.RedirectStandardError = $true; $psi.UseShellExecute = $false
    $p = [System.Diagnostics.Process]::Start($psi)
    $out = $p.StandardOutput.ReadToEndAsync(); $err = $p.StandardError.ReadToEndAsync()
    if (-not $p.WaitForExit($TimeoutSec * 1000)) { try { $p.Kill($true) } catch { }; throw "child process timed out: $ScriptPath" }
    $p.WaitForExit()
    [pscustomobject]@{ ExitCode = $p.ExitCode; Output = $out.Result; Error = $err.Result }
}

function Get-FileBytesOrEmpty {
    param([string]$Path)
    if (Test-Path -LiteralPath $Path -PathType Leaf) { , [IO.File]::ReadAllBytes($Path) } else { , [byte[]]@() }
}

function Test-BytesEqual {
    param([byte[]]$A, [byte[]]$B)
    [System.Linq.Enumerable]::SequenceEqual($A, $B)
}

function Invoke-TestMain {
    param([Parameter(Mandatory)][scriptblock]$Body)
    try { & $Body }
    catch { Write-Host "FAIL: unexpected error: $($_.Exception.Message)" -ForegroundColor Red; Write-Host $_.ScriptStackTrace; $script:FailCount++ }
    finally { Remove-TempDirs }
    Write-Host ''
    Write-Host "Results: $script:PassCount passed, $script:FailCount failed"
    if ($script:FailCount -gt 0) { exit 1 } else { exit 0 }
}