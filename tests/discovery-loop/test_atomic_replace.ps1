#Requires -Version 7.0
# Atomic replace with a bounded retry (task 2.27 fix, 2026-11-13). Real Windows file handles, temporary directories only. No Docker,
# no lock, no measurement file, no container. A helper thread holds a real handle on the target to reproduce the denial.
. (Join-Path $PSScriptRoot 'lib/testlib.ps1')
Import-Module (Join-Path $script:ToolsDir 'DiscoveryCommon.psm1') -Force -DisableNameChecking
Import-Module (Join-Path $script:ToolsDir 'LeaseTiming.psm1') -Force -DisableNameChecking
Import-Module (Join-Path $script:ToolsDir 'DiscoveryLauncher.psm1') -Force -DisableNameChecking

Add-Type -TypeDefinition @"
using System; using System.IO; using System.Threading; using System.Collections.Generic;
public static class PhxHandle {
    // Opens the file for reading with the given share mode on a dedicated thread and keeps the handle for ms milliseconds.
    public static Thread Hold(string path, FileShare share, int ms) {
        var ready = new ManualResetEventSlim();
        var t = new Thread(() => { using (var f = new FileStream(path, FileMode.Open, FileAccess.Read, share)) { ready.Set(); Thread.Sleep(ms); } });
        t.Start(); ready.Wait(); return t;
    }
    // Reads the file in a tight loop (short handles, like the container reader) until stopped; records every distinct result.
    public static volatile bool Stop;
    public static List<string> Seen = new List<string>();
    public static Thread Reader(string path) {
        Stop = false; Seen = new List<string>();
        var t = new Thread(() => { while (!Stop) { string s; try { s = File.ReadAllText(path); } catch (FileNotFoundException) { s = "<missing>"; } catch (IOException) { s = null; } catch (UnauthorizedAccessException) { s = null; } if (s != null) lock (Seen) Seen.Add(s); } });
        t.Start(); return t;
    }
}
"@

Invoke-TestMain {
    Write-Host '=== Atomic replace with bounded retry (task 2.27 fix) ===' -ForegroundColor Cyan
    $cfg = Get-AtomicReplaceSettings
    $timing = Get-LeaseTimingSettings -Settings (Get-LeaseSettings)

    # ---------------------------------------------------------------- reproduction of the Windows behavior
    $d = New-TempDir; $target = Join-Path $d 'heartbeat'; $tmp = "$target.tmp"
    $modes = @([IO.FileShare]::Read, [IO.FileShare]::ReadWrite, ([IO.FileShare]::ReadWrite -bor [IO.FileShare]::Delete))
    $raw = foreach ($m in $modes) {
        [IO.File]::WriteAllText($target, '1'); [IO.File]::WriteAllText($tmp, '2')
        $h = [IO.File]::Open($target, 'Open', 'Read', $m)
        $r = try { [IO.File]::Move($tmp, $target, $true); 'ok' } catch { $e = $_.Exception; if ($e.InnerException) { $e = $e.InnerException }; '{0}:0x{1:X8}' -f $e.GetType().Name, $e.HResult }
        $h.Dispose()
        $after = try { [IO.File]::Move($tmp, $target, $true); 'ok' } catch { 'fail' }
        "$m=$r/$after"
    }
    Test-Case 'reproduction: a rename over a file with an open reader handle is refused with UnauthorizedAccessException 0x80070005 for every share mode, and succeeds once the handle is closed' (@($raw | Where-Object { $_ -notmatch '=UnauthorizedAccessException:0x80070005/ok$' }).Count -eq 0) ($raw -join '; ')
    Test-Case 'reproduction: that refusal is classified as transient while the target is a writable regular file' ((Test-TransientReplaceDenial -Exception ([UnauthorizedAccessException]::new('x')) -Target $target))

    # ---------------------------------------------------------------- recovery from a transient denial
    [IO.File]::WriteAllText($target, 'old')
    $th = [PhxHandle]::Hold($target, [IO.FileShare]::Read, 100)
    Write-TextAtomically -Path $target -Text 'new'
    $th.Join(); $last = Get-LastAtomicReplace
    Test-Case 'recovery: a handle held for 100 ms delays the replace, which then succeeds within the budget with the new content and no temporary file' ($last.Outcome -eq 'replaced' -and $last.Attempts -gt 1 -and $last.ElapsedMs -le $cfg.RetryBudgetMs -and [IO.File]::ReadAllText($target) -ceq 'new' -and -not (Test-Path -LiteralPath $tmp)) "attempts=$($last.Attempts) elapsed=$($last.ElapsedMs)"

    $lease = New-RunLease -LeaseDir (Join-Path $d 'lease') -RunId 'run-20260101T000000Z-0123456789ab' -Nonce 'n' -Settings (Get-LeaseSettings)
    $hbPath = Join-Path $lease.Dir 'heartbeat'
    [void](Step-LeaseHeartbeat -Lease $lease)   # warm-up (first call compiles the function); the measured call below must meet a held handle
    $th = [PhxHandle]::Hold($hbPath, [IO.FileShare]::Read, 80)
    $v = Step-LeaseHeartbeat -Lease $lease
    $th.Join()
    Test-Case 'recovery: Step-LeaseHeartbeat (the Launcher and the measurement writer) renews the counter through a held reader handle' ($v -eq 3 -and [IO.File]::ReadAllText($hbPath) -ceq '3' -and (Get-LastAtomicReplace).Attempts -gt 1) "value=$v attempts=$((Get-LastAtomicReplace).Attempts)"

    # ---------------------------------------------------------------- no recovery within the budget: fail closed
    [IO.File]::WriteAllText($target, 'old')
    $th = [PhxHandle]::Hold($target, [IO.FileShare]::Read, 1000)
    $err = $null; $sw = [Diagnostics.Stopwatch]::StartNew()
    try { Write-TextAtomically -Path $target -Text 'new' } catch { $err = $_.Exception }
    $spent = $sw.ElapsedMilliseconds; $last = Get-LastAtomicReplace
    $contentDuring = try { $s2 = [IO.File]::Open($target, 'Open', 'Read', 'ReadWrite'); $r = [IO.StreamReader]::new($s2).ReadToEnd(); $s2.Dispose(); $r } catch { '<unreadable>' }
    $th.Join()
    Test-Case 'deadline: a handle held for 1000 ms makes the write fail (UnauthorizedAccessException), budget_exceeded, after no more than the budget plus one poll and scheduling slack' ($err -is [UnauthorizedAccessException] -and $last.Outcome -eq 'budget_exceeded' -and $last.ElapsedMs -le $cfg.RetryBudgetMs -and $spent -lt ($cfg.RetryBudgetMs + 150)) "err=$($err.GetType().Name) outcome=$($last.Outcome) elapsed=$($last.ElapsedMs) spent=$spent"
    Test-Case 'deadline: after the failure the target still holds its previous complete content and the temporary file is removed' ($contentDuring -ceq 'old' -and [IO.File]::ReadAllText($target) -ceq 'old' -and -not (Test-Path -LiteralPath $tmp)) "content=$contentDuring"

    # ---------------------------------------------------------------- other errors are not retried
    $dirTarget = Join-Path $d 'adir'; [void][IO.Directory]::CreateDirectory($dirTarget)
    $e1 = $null; try { Write-TextAtomically -Path $dirTarget -Text 'x' } catch { $e1 = $_.Exception }
    $l1 = Get-LastAtomicReplace
    $ro = Join-Path $d 'readonly'; [IO.File]::WriteAllText($ro, 'old'); [IO.File]::SetAttributes($ro, [IO.FileAttributes]::ReadOnly)
    $e2 = $null; try { Write-TextAtomically -Path $ro -Text 'x' } catch { $e2 = $_.Exception }
    $l2 = Get-LastAtomicReplace
    [IO.File]::SetAttributes($ro, [IO.FileAttributes]::Normal)
    Test-Case 'no retry: a target that is a directory fails at the first attempt (not_retried)' ($null -ne $e1 -and $l1.Outcome -eq 'not_retried' -and $l1.Attempts -eq 1) "outcome=$($l1.Outcome) attempts=$($l1.Attempts)"
    Test-Case 'no retry: a read-only target fails at the first attempt (not_retried) and keeps its content' ($null -ne $e2 -and $l2.Outcome -eq 'not_retried' -and $l2.Attempts -eq 1 -and [IO.File]::ReadAllText($ro) -ceq 'old') "outcome=$($l2.Outcome) attempts=$($l2.Attempts)"
    $e3 = $null; try { Write-TextAtomically -Path (Join-Path $d 'missing-dir/heartbeat') -Text 'x' } catch { $e3 = $_.Exception }
    Test-Case 'no retry: a missing directory fails at once' ($null -ne $e3)
    Test-Case 'no retry: a non-Win32 error and an access denial on an absent target are not transient' (-not (Test-TransientReplaceDenial -Exception ([InvalidOperationException]::new('x')) -Target $target) -and -not (Test-TransientReplaceDenial -Exception ([UnauthorizedAccessException]::new('x')) -Target (Join-Path $d 'absent')))

    # ---------------------------------------------------------------- atomicity under a concurrent reader
    $atom = Join-Path $d 'atomic'; [IO.File]::WriteAllText($atom, 'v0000')
    $values = [System.Collections.Generic.HashSet[string]]::new([string[]]@('v0000'))
    $rt = [PhxHandle]::Reader($atom)
    $retried = 0
    for ($i = 1; $i -le 300; $i++) { $val = 'v{0:D4}' -f $i; [void]$values.Add($val); Write-TextAtomically -Path $atom -Text $val; if ((Get-LastAtomicReplace).Attempts -gt 1) { $retried++ } }
    [PhxHandle]::Stop = $true; $rt.Join()
    $seen = @([PhxHandle]::Seen)
    $bad = @($seen | Where-Object { -not $values.Contains($_) } | Select-Object -Unique)
    Test-Case 'atomicity: under a concurrent reader every read is one complete written value (never empty, partial, or missing), and the last value is the target content' ($seen.Count -gt 0 -and $bad.Count -eq 0 -and [IO.File]::ReadAllText($atom) -ceq 'v0300') "reads=$($seen.Count) bad=$($bad -join ',') retried=$retried"
    $fnSrc = (Get-Command Write-TextAtomically).Definition
    Test-Case 'atomicity: the function writes only the temporary file and replaces the target by rename (no in-place write of the target)' ($fnSrc.Contains('[System.IO.FileStream]::new($tmp,') -and $fnSrc.Contains('[System.IO.File]::Move($tmp, $Path, $true)') -and -not ($fnSrc -match 'FileStream\]::new\(\$Path') -and -not ($fnSrc -match 'WriteAll(Text|Bytes)\(\$Path'))

    # ---------------------------------------------------------------- the timing constraints are unchanged
    Test-Case 'timing: the retry budget equals the jitter allowance J (250 ms); H 1000, S 4000, P 500, A 2000 are unchanged' ($cfg.RetryBudgetMs -eq $timing['jitterMs'] -and $timing['jitterMs'] -eq 250 -and $timing['heartbeatIntervalMs'] -eq 1000 -and $timing['staleAfterMs'] -eq 4000 -and $timing['watchIntervalMs'] -eq 500 -and $timing['abortBudgetMs'] -eq 2000 -and $cfg.RetryPollMs -gt 0 -and $cfg.RetryPollMs -lt $cfg.RetryBudgetMs)

    # ---------------------------------------------------------------- one shared implementation for the Launcher and the measurement
    $tools = $script:ToolsDir
    $launcherSrc = [IO.File]::ReadAllText((Join-Path $tools 'DiscoveryLauncher.psm1'))
    $moves = [regex]::Matches($launcherSrc, '\[System\.IO\.File\]::Move\(').Count
    Test-Case 'shared: DiscoveryLauncher.psm1 has exactly one rename (inside Write-TextAtomically); New-RunLease, Step-LeaseHeartbeat, and Revoke-RunLease write through it' ($moves -eq 1 -and (Get-Command New-RunLease).Definition.Contains('Write-TextAtomically') -and (Get-Command Step-LeaseHeartbeat).Definition.Contains('Write-TextAtomically') -and (Get-Command Revoke-RunLease).Definition.Contains('Write-TextAtomically'))
    $measureSrc = [IO.File]::ReadAllText((Join-Path $tools 'LeaseMeasure.psm1')); $writerSrc = [IO.File]::ReadAllText((Join-Path $tools 'LeaseWriter.ps1'))
    Test-Case 'shared: the measurement module and the writer process contain no rename, and no direct file write except to their diagnostic file; they use Step-LeaseHeartbeat, New-RunLease, and Write-TextAtomically' (-not ($measureSrc + $writerSrc -match 'File\]::(Move|Replace)') -and @([regex]::Matches($measureSrc + $writerSrc, 'File\]::(WriteAll\w*|Append\w*)\(\s*([^,]+),') | Where-Object { $_.Groups[2].Value.Trim() -cnotin @('$diagPath', '$DiagPath') }).Count -eq 0 -and $writerSrc.Contains('Step-LeaseHeartbeat') -and $measureSrc.Contains('Step-LeaseHeartbeat') -and $measureSrc.Contains('Write-TextAtomically'))
    # in fresh processes, with the imports of LeaseWriter.ps1 and of LeaseMeasure.psm1, the command resolves to DiscoveryLauncher
    $probe = Join-Path (New-TempDir) 'resolve.ps1'
    [IO.File]::WriteAllText($probe, @"
param([string]`$Tools, [string]`$Via)
Import-Module (Join-Path `$Tools `$Via) -Force -DisableNameChecking
if (`$Via -eq 'LeaseMeasure.psm1') { `$m = Get-Module LeaseMeasure; `$cmd = & `$m { Get-Command Write-TextAtomically }; `$hb = & `$m { Get-Command Step-LeaseHeartbeat } }
else { `$cmd = Get-Command Write-TextAtomically; `$hb = Get-Command Step-LeaseHeartbeat }
'module=' + `$cmd.ModuleName + '|' + `$hb.ModuleName + '|budget=' + (Get-Module DiscoveryLauncher -All | Select-Object -First 1 | ForEach-Object { & `$_ { `$script:ReplaceRetryBudgetMs } })
"@)
    $viaWriter = (Invoke-ChildPwsh -ScriptPath $probe -Arguments @('-Tools', $tools, '-Via', 'DiscoveryLauncher.psm1')).Output.Trim()
    $viaMeasure = (Invoke-ChildPwsh -ScriptPath $probe -Arguments @('-Tools', $tools, '-Via', 'LeaseMeasure.psm1')).Output.Trim()
    Test-Case 'shared: the writer (LeaseWriter.ps1 imports) and the measurement module resolve Write-TextAtomically and Step-LeaseHeartbeat to DiscoveryLauncher with the same budget' ($viaWriter -ceq 'module=DiscoveryLauncher|DiscoveryLauncher|budget=250' -and $viaMeasure -ceq $viaWriter) "writer=$viaWriter measure=$viaMeasure"
}