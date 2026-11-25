#Requires -Version 7.0
# RuntimeReport tests (task 4.9-C1). Pure functions: no file is written, no Docker, no network. The vocabulary and the line shapes are compared
# with packages/discovery-loop/src/main.ts and src/config/startup.ts AS TEXT (sets, not counts). The TypeScript code is not run here.
. (Join-Path $PSScriptRoot 'lib/testlib.ps1')
Import-Module (Join-Path $script:ToolsDir 'DiscoveryCommon.psm1') -Force -DisableNameChecking
Import-Module (Join-Path $script:ToolsDir 'RuntimeReport.psm1') -Force -DisableNameChecking

$utf8 = [System.Text.UTF8Encoding]::new($false)
function Get-Text { param([string]$Rel) [IO.File]::ReadAllText((Join-Path $script:RepoRoot $Rel)) }
function Get-TsList { param([string]$Text, [string]$Name) $m = [regex]::Match($Text, '\b' + [regex]::Escape($Name) + '\b[^=]*=\s*Object\.freeze\(\s*\[([^\]]*)\]'); if (-not $m.Success) { return $null }; @([regex]::Matches($m.Groups[1].Value, '"([^"]+)"') | ForEach-Object { $_.Groups[1].Value }) }
function Test-SameSet { param($A, $B) ($null -ne $A) -and ($null -ne $B) -and @($A).Count -eq @($B).Count -and @($A | Select-Object -Unique).Count -eq @($A).Count -and @($B | Select-Object -Unique).Count -eq @($B).Count -and ((@($A | Sort-Object -CaseSensitive) -join ',') -ceq (@($B | Sort-Object -CaseSensitive) -join ',')) }
function Get-Report { param([string]$Line, [int]$Exit) ConvertFrom-RuntimeReport -Bytes ($utf8.GetBytes($Line + "`n")) -ExitCode $Exit }
function Get-CodeOnly { param([string]$Text) (($Text -split "`n") | Where-Object { $t = $_.Trim(); -not ($t.StartsWith('#') -or $t.StartsWith('//')) }) -join "`n" }
$marker = 'SECRET-MARKER-123'
$reportCodes = @('report_absent', 'report_too_large', 'report_not_single_line', 'report_not_utf8', 'report_not_json', 'report_not_object', 'report_keys_invalid', 'report_type_invalid', 'report_value_invalid')

Invoke-TestMain {
    Write-Host '=== RuntimeReport (task 4.9-C1) ===' -ForegroundColor Cyan
    $v = Get-RuntimeReportVocabulary
    $main = Get-Text 'packages/discovery-loop/src/main.ts'
    $startup = Get-Text 'packages/discovery-loop/src/config/startup.ts'

    # ---------------------------------------------------------------- vocabulary parity: SETS, both directions, no duplicate
    $pairs = @(
        @('INPUT_CODES', $main, $v.InputCodes), @('ASSEMBLY_CODES', $main, $v.AssemblyCodes), @('CONFIG_ISSUE_CODES', $main, $v.ConfigIssueCodes), @('COMPOSE_CODES', $main, $v.ComposeCodes),
        @('TERMINATION_REASON_NAMES', $main, $v.TerminationReasons), @('UNSEALED_FAILURE_NAMES', $main, $v.UnsealedFailures), @('TIMER_NOTES', $main, $v.TimerNotes),
        @('STARTUP_CHECK_ORDER', $startup, $v.StartupChecks), @('STARTUP_REFUSAL_CODES', $startup, $v.StartupRefusalCodes)
    )
    foreach ($pr in $pairs) {
        $ts = Get-TsList $pr[1] $pr[0]
        Test-Case "parity: $($pr[0]) equals the PowerShell vocabulary as a set ($(@($pr[2]).Count) members, no duplicate, no member on one side only)" (Test-SameSet $ts $pr[2]) "ts=$((@($ts) -join ',')) ps=$((@($pr[2]) -join ','))"
    }
    $phaseTs = @([regex]::Matches([regex]::Match($main, 'type Phase = ([^;]+);').Groups[1].Value, '"([^"]+)"') | ForEach-Object { $_.Groups[1].Value })
    Test-Case 'parity: the Phase union of main.ts equals the PowerShell phases as a set' (Test-SameSet $phaseTs $v.Phases) ($phaseTs -join ',')
    Test-Case 'parity: the lists are not trivially empty (the extraction found the TypeScript lists)' ((Get-TsList $startup 'STARTUP_REFUSAL_CODES').Count -eq 23 -and (Get-TsList $main 'TERMINATION_REASON_NAMES').Count -eq 11 -and (Get-TsList $main 'UNSEALED_FAILURE_NAMES').Count -eq 8)
    $normal4 = @('iteration_limit_reached', 'experiment_limit_reached', 'time_limit_reached', 'no_further_experiments')
    Test-Case 'termination classes: the four normal reasons are exactly the approved four, they are listed reasons, and every other listed reason is abnormal' ((Test-SameSet $v.NormalTerminationReasons $normal4) -and @($normal4 | Where-Object { $v.TerminationReasons -cnotcontains $_ }).Count -eq 0 -and @($v.TerminationReasons | Where-Object { $normal4 -cnotcontains $_ } | Where-Object { (Get-RuntimeTerminationClass -Reason $_) -cne 'abnormal' }).Count -eq 0 -and @($normal4 | Where-Object { (Get-RuntimeTerminationClass -Reason $_) -cne 'normal' }).Count -eq 0)
    Test-Case 'termination classes: the runtime marker unlisted is abnormal (never normal), and an unknown or non-string value has no class' ((Get-RuntimeTerminationClass -Reason 'unlisted') -ceq 'abnormal' -and $null -eq (Get-RuntimeTerminationClass -Reason 'whatever') -and $null -eq (Get-RuntimeTerminationClass -Reason $null) -and $null -eq (Get-RuntimeTerminationClass -Reason 5) -and $null -eq (Get-RuntimeTerminationClass -Reason 'Error'))

    # ---------------------------------------------------------------- shape parity with main.ts (what the entry point really writes)
    $shapes = @(
        'const closed = (value: unknown, list: readonly string[]): string => (typeof value === "string" && list.includes(value) ? value : "unlisted");',
        'outcome(2, "input", { code: closed("run_config_missing", INPUT_CODES) })', 'outcome(2, "input", { code: closed("run_config_unreadable", INPUT_CODES) })', 'outcome(2, "input", { code: closed("run_config_invalid", INPUT_CODES) })',
        'outcome(2, "stage_a", { codes: [...new Set(stageA.error.map((i) => closed(i.code, CONFIG_ISSUE_CODES)))] })',
        '({ check: closed(r.check, STARTUP_CHECK_ORDER), code: closed(r.code, STARTUP_REFUSAL_CODES) })', 'outcome(2, "stage_b", { refusals })',
        'outcome(2, "assembly", { code: closed(code, ASSEMBLY_CODES) })', 'outcome(2, "compose", { code: closed(composed.error.code, COMPOSE_CODES) })',
        'outcome(0, "run", { sealed: true, terminationReason: closed(run.summary.terminationReason, TERMINATION_REASON_NAMES) })',
        'outcome(1, "run", {', 'sealed: false,', 'started: run.started === true,', 'failure: closed(run.failure, UNSEALED_FAILURE_NAMES),', '{ terminationReason: closed(run.terminationReason, TERMINATION_REASON_NAMES) }',
        'outcome(1, "internal", { code: "internal_error" })', 'timers: notes.map((n) => closed(n, TIMER_NOTES))', 'write(JSON.stringify(line));', 'process.stderr.write(`${line}\n`);',
        '({ exitCode, line: { phase, ...fields } })'
    )
    $missingShapes = @($shapes | Where-Object { -not $main.Contains($_) })
    Test-Case 'shape parity: every line shape of the vocabulary above is written by main.ts exactly in that form (fields, closed() use, one JSON.stringify line, LF)' ($missingShapes.Count -eq 0) ($missingShapes -join ' || ')
    Test-Case 'shape parity: the exit codes of main.ts are 0 for a sealed Run, 1 otherwise after the start, 2 before the Run (input, stage_a, stage_b, assembly, compose)' (@([regex]::Matches($main, 'outcome\(2, "(input|stage_a|stage_b|assembly|compose)"')).Count -ge 5 -and $main.Contains('outcome(0, "run"') -and $main.Contains('return outcome(1, "run", {') -and -not ($main -match 'outcome\([02], "internal"') -and $main.Contains('process.exitCode = code;'))

    # ---------------------------------------------------------------- valid lines: every phase, with the exit code of that phase
    $okCases = [System.Collections.Generic.List[object]]::new()
    foreach ($c in $v.InputCodes) { $okCases.Add(@("{`"phase`":`"input`",`"code`":`"$c`"}", 2, 'runtime_refused', 'input')) }
    foreach ($c in $v.AssemblyCodes) { $okCases.Add(@("{`"phase`":`"assembly`",`"code`":`"$c`"}", 2, 'runtime_refused', 'assembly')) }
    foreach ($c in $v.ComposeCodes) { $okCases.Add(@("{`"phase`":`"compose`",`"code`":`"$c`"}", 2, 'runtime_refused', 'compose')) }
    $okCases.Add(@('{"phase":"stage_a","codes":["required_missing"]}', 2, 'runtime_refused', 'stage_a'))
    $okCases.Add(@(('{"phase":"stage_a","codes":' + (ConvertTo-Json -Compress -InputObject @($v.ConfigIssueCodes)) + '}'), 2, 'runtime_refused', 'stage_a'))
    $okCases.Add(@('{"phase":"stage_b","refusals":[{"check":"config","code":"config_not_validated"},{"check":"lease","code":"lease_invalid"}]}', 2, 'runtime_refused', 'stage_b'))
    foreach ($c in $v.StartupRefusalCodes) { $okCases.Add(@("{`"phase`":`"stage_b`",`"refusals`":[{`"check`":`"io`",`"code`":`"$c`"}]}", 2, 'runtime_refused', 'stage_b')) }
    foreach ($c in $v.StartupChecks) { $okCases.Add(@("{`"phase`":`"stage_b`",`"refusals`":[{`"check`":`"$c`",`"code`":`"port_failed`"}]}", 2, 'runtime_refused', 'stage_b')) }
    foreach ($c in $v.TerminationReasons) {
        $isNormal = $v.NormalTerminationReasons -ccontains $c
        $okCases.Add(@("{`"phase`":`"run`",`"sealed`":true,`"terminationReason`":`"$c`"}", 0, $(if ($isNormal) { 'runtime_sealed_normal' } else { 'runtime_sealed_abnormal' }), 'run'))
    }
    foreach ($c in $v.UnsealedFailures) { $okCases.Add(@("{`"phase`":`"run`",`"sealed`":false,`"started`":true,`"failure`":`"$c`"}", 1, 'runtime_unsealed', 'run')) }
    $okCases.Add(@('{"phase":"run","sealed":false,"started":false,"failure":"runner_start_refused","terminationReason":"error"}', 1, 'runtime_unsealed', 'run'))
    $okCases.Add(@('{"phase":"internal","code":"internal_error"}', 1, 'runtime_unsealed', 'internal'))
    $okCases.Add(@('{"phase":"run","sealed":true,"terminationReason":"error","timers":["timers_left","timers_not_cleared"]}', 0, 'runtime_sealed_abnormal', 'run'))
    $okCases.Add(@('{"phase":"run","sealed":true,"terminationReason":"time_limit_reached","timers":["timers_left"]}', 0, 'runtime_sealed_normal', 'run'))
    $okCases.Add(@('{"phase":"input","code":"run_config_missing","timers":["timers_not_cleared"]}', 2, 'runtime_refused', 'input'))
    $okCases.Add(@('{"phase":"internal","code":"internal_error","timers":["timers_left"]}', 1, 'runtime_unsealed', 'internal'))
    $badOk = @()
    foreach ($c in $okCases) {
        $r = Get-Report $c[0] $c[1]
        if (-not ($r.Status -ceq 'parsed' -and $null -eq $r.ReportCode -and $r.Consistency -ceq 'consistent' -and $r.Classification -ceq $c[2] -and $r.Phase -ceq $c[3] -and $r.ExitCode -eq $c[1] -and $r.PurposeAssessment -ceq 'not_assessed')) { $badOk += "$($c[0]) -> $($r.Status)/$($r.ReportCode)/$($r.Classification)" }
    }
    Test-Case "valid: $($okCases.Count) valid lines (every phase, every vocabulary member of every field, optional timers) are parsed, consistent with their exit code, and classified" ($badOk.Count -eq 0 -and $okCases.Count -ge 80) ($badOk -join ' || ')
    $r = Get-Report '{"phase":"run","sealed":true,"terminationReason":"iteration_limit_reached"}' 0
    Test-Case 'valid: a normal sealed end is the only case that is eligible for complete (still needs the export), and it claims no purpose' ($r.CompleteEligible -and $r.LauncherExitCode -eq 0 -and $r.TerminationClass -ceq 'normal' -and $r.Sealed -eq $true -and $r.PurposeAssessment -ceq 'not_assessed')
    $r = Get-Report '{"phase":"run","sealed":true,"terminationReason":"error"}' 0
    Test-Case 'valid: error with a sealed manifest is runtime_sealed_abnormal, Launcher exit code 1, not eligible for complete (exit code 0 of the runtime is not a goal)' (-not $r.CompleteEligible -and $r.LauncherExitCode -eq 1 -and $r.Classification -ceq 'runtime_sealed_abnormal' -and $r.TerminationClass -ceq 'abnormal' -and $r.ExitCode -eq 0)
    $abnormalAll = @($v.TerminationReasons | Where-Object { $normal4 -cnotcontains $_ } | Where-Object { $rr = Get-Report ('{"phase":"run","sealed":true,"terminationReason":"' + $_ + '"}') 0; $rr.CompleteEligible -or $rr.LauncherExitCode -ne 1 -or $rr.Classification -cne 'runtime_sealed_abnormal' })
    Test-Case 'valid: all seven abnormal termination reasons with a sealed manifest give runtime_sealed_abnormal and Launcher exit code 1' ($abnormalAll.Count -eq 0)
    Test-Case 'valid: only the four normal reasons are eligible for complete (no other line is)' (@($okCases | Where-Object { $x = Get-Report $_[0] $_[1]; $x.CompleteEligible } | Where-Object { $_[2] -cne 'runtime_sealed_normal' }).Count -eq 0 -and @($okCases | Where-Object { $_[2] -ceq 'runtime_sealed_normal' }).Count -eq 5)

    # ---------------------------------------------------------------- the runtime marker unlisted: accepted ONLY where main.ts passes the value through closed()
    $unl = @(
        '{"phase":"input","code":"unlisted"}', '{"phase":"assembly","code":"unlisted"}', '{"phase":"compose","code":"unlisted"}', '{"phase":"stage_a","codes":["unlisted","required_missing"]}',
        '{"phase":"stage_b","refusals":[{"check":"unlisted","code":"unlisted"}]}', '{"phase":"run","sealed":false,"started":true,"failure":"unlisted"}',
        '{"phase":"run","sealed":false,"started":false,"failure":"seal_failed","terminationReason":"unlisted"}', '{"phase":"run","sealed":true,"terminationReason":"unlisted","timers":["unlisted"]}'
    )
    $unlExit = @(2, 2, 2, 2, 2, 1, 1, 0)
    $badUnl = @(); for ($i = 0; $i -lt $unl.Count; $i++) { $x = Get-Report $unl[$i] $unlExit[$i]; if ($x.Status -cne 'parsed') { $badUnl += $unl[$i] } }
    Test-Case 'unlisted: the runtime marker is accepted in the eight fields that main.ts fills through closed() (input, assembly, compose, stage_a codes, stage_b check and code, failure, terminationReason, timers)' ($badUnl.Count -eq 0) ($badUnl -join ' || ')
    $x = Get-Report '{"phase":"run","sealed":true,"terminationReason":"unlisted"}' 0
    Test-Case 'unlisted: a sealed end with the reason unlisted is abnormal (runtime_sealed_abnormal, exit code 1), never normal' ($x.Status -ceq 'parsed' -and $x.Classification -ceq 'runtime_sealed_abnormal' -and $x.TerminationClass -ceq 'abnormal' -and -not $x.CompleteEligible -and $x.LauncherExitCode -eq 1)
    $notAllowed = [ordered]@{
        'internal code unlisted (main.ts writes the literal internal_error)' = @('{"phase":"internal","code":"unlisted"}', 1)
        'phase unlisted' = @('{"phase":"unlisted","code":"x"}', 2)
    }
    foreach ($k in $notAllowed.Keys) { $x = Get-Report $notAllowed[$k][0] $notAllowed[$k][1]; Test-Case "unlisted: $k is refused" ($x.Status -ceq 'invalid' -and $x.ReportCode -ceq 'report_value_invalid') "$($x.Status)/$($x.ReportCode)" }
    $unknownValues = [ordered]@{
        'an unknown input code' = @('{"phase":"input","code":"run_config_gone"}', 2); 'an unknown assembly code' = @('{"phase":"assembly","code":"x"}', 2); 'an unknown compose code' = @('{"phase":"compose","code":"x"}', 2)
        'an unknown stage_a code' = @('{"phase":"stage_a","codes":["x"]}', 2); 'an unknown stage_b check' = @('{"phase":"stage_b","refusals":[{"check":"x","code":"port_failed"}]}', 2)
        'an unknown stage_b code' = @('{"phase":"stage_b","refusals":[{"check":"io","code":"x"}]}', 2); 'an unknown termination reason' = @('{"phase":"run","sealed":true,"terminationReason":"goal_reached"}', 0)
        'an unknown failure' = @('{"phase":"run","sealed":false,"started":true,"failure":"boom"}', 1); 'an unknown timer note' = @('{"phase":"run","sealed":true,"terminationReason":"error","timers":["x"]}', 0)
        'a value with different letter case' = @('{"phase":"run","sealed":true,"terminationReason":"Error"}', 0); 'a value with a trailing space' = @('{"phase":"run","sealed":true,"terminationReason":"error "}', 0)
        'the empty string' = @('{"phase":"input","code":""}', 2); 'an unknown phase' = @('{"phase":"seal","code":"x"}', 2)
    }
    foreach ($k in $unknownValues.Keys) { $x = Get-Report $unknownValues[$k][0] $unknownValues[$k][1]; Test-Case "unknown value: $k is REFUSED (not turned into unlisted and accepted)" ($x.Status -ceq 'invalid' -and $x.ReportCode -ceq 'report_value_invalid' -and $x.Classification -ceq 'runtime_report_invalid' -and $null -eq $x.TerminationReason -and $null -eq $x.Code) "$($x.Status)/$($x.ReportCode)" }

    # ---------------------------------------------------------------- a refusal returns nothing from the line, even after a partial parse (regression)
    $isReset = {
        param($x)
        $null -eq $x.Phase -and $null -eq $x.Sealed -and $null -eq $x.Started -and $null -eq $x.TerminationReason -and $null -eq $x.TerminationClass -and
        $null -eq $x.Failure -and $null -eq $x.Code -and @($x.Codes).Count -eq 0 -and @($x.Refusals).Count -eq 0 -and @($x.Timers).Count -eq 0 -and
        $x.Consistency -ceq 'not_applicable' -and $x.Classification -ceq 'runtime_report_invalid' -and -not $x.CompleteEligible -and $x.LauncherExitCode -eq 1 -and $x.PurposeAssessment -ceq 'not_assessed'
    }
    $late = [ordered]@{
        'an unknown timer note after a valid sealed run line' = @('{"phase":"run","sealed":true,"terminationReason":"error","timers":["x"]}', 0, 'report_value_invalid')
        'a bad timers type after a valid unsealed run line' = @('{"phase":"run","sealed":false,"started":true,"failure":"seal_failed","terminationReason":"error","timers":"timers_left"}', 1, 'report_type_invalid')
        'an unknown reason after a valid started and failure' = @('{"phase":"run","sealed":false,"started":true,"failure":"seal_failed","terminationReason":"x"}', 1, 'report_value_invalid')
        'a bad second refusal after a valid first one' = @('{"phase":"stage_b","refusals":[{"check":"config","code":"config_not_validated"},{"check":"io","code":"x"}]}', 2, 'report_value_invalid')
        'an unknown timer note after valid stage_a codes' = @('{"phase":"stage_a","codes":["required_missing"],"timers":["x"]}', 2, 'report_value_invalid')
        'an unknown timer note after a valid input code' = @(('{"phase":"input","code":"run_config_missing","timers":["' + $marker + '"]}'), 2, 'report_value_invalid')
    }
    foreach ($k in $late.Keys) {
        $x = Get-Report $late[$k][0] $late[$k][1]
        $leak = (ConvertTo-Json -InputObject $x -Depth 6) -match [regex]::Escape($marker)
        Test-Case "reset: $k is refused as $($late[$k][2]), every field that comes from the line is reset, the reason code and the runtime exit code are kept, and no input text is in the result" ($x.Status -ceq 'invalid' -and $x.ReportCode -ceq $late[$k][2] -and $x.ExitCode -eq $late[$k][1] -and (& $isReset $x) -and -not $leak) "$($x.Status)/$($x.ReportCode)/phase=$($x.Phase)/reason=$($x.TerminationReason)/codes=$(@($x.Codes).Count)/refusals=$(@($x.Refusals).Count)"
    }
    $keep = Get-Report '{"phase":"run","sealed":true,"terminationReason":"iteration_limit_reached","timers":["timers_left"]}' 0
    Test-Case 'keep: a valid sealed run line keeps Phase, Sealed, TerminationReason, TerminationClass, and Timers' ($keep.Status -ceq 'parsed' -and $keep.Phase -ceq 'run' -and $keep.Sealed -eq $true -and $keep.TerminationReason -ceq 'iteration_limit_reached' -and $keep.TerminationClass -ceq 'normal' -and (@($keep.Timers) -join ',') -ceq 'timers_left' -and $keep.Classification -ceq 'runtime_sealed_normal')
    $keepA = Get-Report '{"phase":"stage_a","codes":["unknown_key","out_of_range"]}' 2
    Test-Case 'keep: a valid stage_a line keeps Codes in the order written' ($keepA.Status -ceq 'parsed' -and (@($keepA.Codes) -join ',') -ceq 'unknown_key,out_of_range' -and $keepA.Classification -ceq 'runtime_refused')
    $keepI = Get-Report '{"phase":"input","code":"run_config_invalid"}' 1
    Test-Case 'keep: an exit code that is inconsistent with a valid line keeps the parsed values but is never eligible for complete (existing contract)' ($keepI.Status -ceq 'parsed' -and $keepI.Code -ceq 'run_config_invalid' -and $keepI.Consistency -ceq 'inconsistent' -and $keepI.Classification -ceq 'runtime_report_inconsistent' -and -not $keepI.CompleteEligible -and $keepI.LauncherExitCode -eq 1)

    # ---------------------------------------------------------------- keys, types, structure
    $structure = [ordered]@{
        'no phase' = @('{"code":"run_config_missing"}', 'report_keys_invalid'); 'phase of the wrong type' = @('{"phase":1}', 'report_type_invalid'); 'phase null' = @('{"phase":null}', 'report_type_invalid')
        'a key that differs only in letter case' = @('{"Phase":"input","code":"run_config_missing"}', 'report_keys_invalid'); 'an unknown key' = @('{"phase":"input","code":"run_config_missing","extra":"x"}', 'report_keys_invalid')
        'a missing code' = @('{"phase":"input"}', 'report_keys_invalid'); 'a code of the wrong type' = @('{"phase":"input","code":1}', 'report_type_invalid'); 'a code that is null' = @('{"phase":"input","code":null}', 'report_type_invalid')
        'a code that is a list' = @('{"phase":"input","code":["run_config_missing"]}', 'report_type_invalid'); 'stage_a with code instead of codes' = @('{"phase":"stage_a","code":"required_missing"}', 'report_keys_invalid')
        'stage_a codes as a string' = @('{"phase":"stage_a","codes":"required_missing"}', 'report_type_invalid'); 'stage_a codes empty' = @('{"phase":"stage_a","codes":[]}', 'report_value_invalid')
        'stage_a codes with a duplicate' = @('{"phase":"stage_a","codes":["required_missing","required_missing"]}', 'report_value_invalid'); 'stage_a codes with a number' = @('{"phase":"stage_a","codes":[1]}', 'report_type_invalid')
        'stage_a codes with a nested list' = @('{"phase":"stage_a","codes":[["required_missing"]]}', 'report_type_invalid')
        'stage_b refusals as an object' = @('{"phase":"stage_b","refusals":{"check":"io","code":"port_failed"}}', 'report_type_invalid'); 'stage_b refusals empty' = @('{"phase":"stage_b","refusals":[]}', 'report_value_invalid')
        'stage_b refusal that is a string' = @('{"phase":"stage_b","refusals":["io"]}', 'report_type_invalid'); 'stage_b refusal with an extra key' = @('{"phase":"stage_b","refusals":[{"check":"io","code":"port_failed","name":"x"}]}', 'report_keys_invalid')
        'stage_b refusal without a code' = @('{"phase":"stage_b","refusals":[{"check":"io"}]}', 'report_keys_invalid'); 'stage_b refusal with a check of the wrong type' = @('{"phase":"stage_b","refusals":[{"check":1,"code":"port_failed"}]}', 'report_type_invalid')
        'stage_b refusal key letter case' = @('{"phase":"stage_b","refusals":[{"Check":"io","code":"port_failed"}]}', 'report_keys_invalid')
        'run without sealed' = @('{"phase":"run","terminationReason":"error"}', 'report_keys_invalid'); 'run with sealed as a string' = @('{"phase":"run","sealed":"true","terminationReason":"error"}', 'report_type_invalid')
        'run sealed without a reason' = @('{"phase":"run","sealed":true}', 'report_keys_invalid'); 'run sealed with started' = @('{"phase":"run","sealed":true,"started":true,"terminationReason":"error"}', 'report_keys_invalid')
        'run sealed with failure' = @('{"phase":"run","sealed":true,"terminationReason":"error","failure":"seal_failed"}', 'report_keys_invalid'); 'run unsealed without started' = @('{"phase":"run","sealed":false,"failure":"seal_failed"}', 'report_keys_invalid')
        'run unsealed without failure' = @('{"phase":"run","sealed":false,"started":true}', 'report_keys_invalid'); 'run unsealed with started as a number' = @('{"phase":"run","sealed":false,"started":1,"failure":"seal_failed"}', 'report_type_invalid')
        'run unsealed with started as a string' = @('{"phase":"run","sealed":false,"started":"true","failure":"seal_failed"}', 'report_type_invalid'); 'run unsealed with a reason of the wrong type' = @('{"phase":"run","sealed":false,"started":true,"failure":"seal_failed","terminationReason":3}', 'report_type_invalid')
        'internal with a code of the wrong type' = @('{"phase":"internal","code":null}', 'report_type_invalid'); 'internal with another code' = @('{"phase":"internal","code":"store_failed"}', 'report_value_invalid')
        'timers empty' = @('{"phase":"input","code":"run_config_missing","timers":[]}', 'report_value_invalid'); 'timers with a duplicate' = @('{"phase":"input","code":"run_config_missing","timers":["timers_left","timers_left"]}', 'report_value_invalid')
        'timers with three members' = @('{"phase":"input","code":"run_config_missing","timers":["timers_left","timers_not_cleared","unlisted"]}', 'report_value_invalid'); 'timers as a string' = @('{"phase":"input","code":"run_config_missing","timers":"timers_left"}', 'report_type_invalid')
        'a number anywhere' = @('{"phase":"run","sealed":true,"terminationReason":"error","n":1}', 'report_keys_invalid'); 'a nested object value' = @('{"phase":"input","code":{"a":"b"}}', 'report_type_invalid')
        'a duplicate key' = @('{"phase":"input","phase":"input","code":"run_config_missing"}', 'report_not_json'); 'a duplicate key in a refusal' = @('{"phase":"stage_b","refusals":[{"check":"io","check":"io","code":"port_failed"}]}', 'report_not_json')
        'not an object: a list' = @('[]', 'report_not_object'); 'not an object: a string' = @('"x"', 'report_not_object'); 'not an object: a number' = @('1', 'report_not_object'); 'not an object: null' = @('null', 'report_not_object'); 'not an object: true' = @('true', 'report_not_object')
        'broken JSON' = @('{"phase":"input"', 'report_not_json'); 'a trailing comma' = @('{"phase":"input","code":"run_config_missing",}', 'report_not_json'); 'a comment' = @('{"phase":"input","code":"run_config_missing"/**/}', 'report_not_json')
        'plain text such as a Node.js stack trace' = @(('Error: ' + $marker + ' at Object.<anonymous> (/app/x.js:1:1)'), 'report_not_json'); 'two objects' = @('{"phase":"input","code":"run_config_missing"}{"phase":"input","code":"run_config_missing"}', 'report_not_json')
    }
    foreach ($k in $structure.Keys) { $x = Get-Report $structure[$k][0] 2; Test-Case "structure: $k is refused as $($structure[$k][1])" ($x.Status -ceq 'invalid' -and $x.ReportCode -ceq $structure[$k][1] -and $x.Classification -ceq 'runtime_report_invalid') "$($x.Status)/$($x.ReportCode)" }
    $many = '{"phase":"stage_b","refusals":[' + ((1..65 | ForEach-Object { '{"check":"io","code":"port_failed"}' }) -join ',') + ']}'
    $x = Get-Report $many 2; $y = Get-Report ('{"phase":"stage_b","refusals":[' + ((1..64 | ForEach-Object { '{"check":"io","code":"port_failed"}' }) -join ',') + ']}') 2
    Test-Case 'structure: 64 refusals are accepted and 65 are refused (the bound of the list)' ($y.Status -ceq 'parsed' -and $x.ReportCode -ceq 'report_value_invalid')

    # ---------------------------------------------------------------- the bytes: size, one line, UTF-8, BOM, NUL, CR
    $good = $utf8.GetBytes('{"phase":"input","code":"run_config_missing"}')
    $byteCases = [ordered]@{
        'null bytes' = @($null, 'report_absent'); 'no bytes' = @([byte[]]::new(0), 'report_absent')
        'no final line feed' = @($good, 'report_not_single_line'); 'a CR LF line end' = @(($good + [byte[]](13, 10)), 'report_not_single_line')
        'two lines' = @(($good + [byte[]](10) + $good + [byte[]](10)), 'report_not_single_line'); 'a leading line feed' = @(([byte[]](10) + $good + [byte[]](10)), 'report_not_single_line')
        'two line feeds at the end' = @(($good + [byte[]](10, 10)), 'report_not_single_line'); 'a NUL byte' = @(([byte[]](0) + $good + [byte[]](10)), 'report_not_single_line')
        'a CR inside' = @(([byte[]](13) + $good + [byte[]](10)), 'report_not_single_line'); 'only a line feed' = @(([byte[]](10)), 'report_not_json')
        'bytes that are not UTF-8' = @(([byte[]](0x7B, 0xFF, 0x7D, 10)), 'report_not_utf8'); 'an overlong UTF-8 form' = @(([byte[]](0x7B, 0xC0, 0xAF, 0x7D, 10)), 'report_not_utf8')
        'an encoded surrogate' = @(([byte[]](0x7B, 0xED, 0xA0, 0x80, 0x7D, 10)), 'report_not_utf8'); 'a byte-order mark' = @(([byte[]](0xEF, 0xBB, 0xBF) + $good + [byte[]](10)), 'report_not_json')
        '8192 bytes that are not JSON (inside the bound)' = @(([byte[]](,[byte][char]'x' * 8191) + [byte[]](10)), 'report_not_json'); '8193 bytes (above the bound)' = @(([byte[]](,[byte][char]'x' * 8192) + [byte[]](10)), 'report_too_large')
    }
    foreach ($k in $byteCases.Keys) {
        $x = ConvertFrom-RuntimeReport -Bytes $byteCases[$k][0] -ExitCode 2
        Test-Case "bytes: $k is refused as $($byteCases[$k][1])" ($x.ReportCode -ceq $byteCases[$k][1] -and $x.Status -cin @('invalid', 'absent') -and $x.Classification -ceq 'runtime_report_invalid') "$($x.Status)/$($x.ReportCode)"
    }
    Test-Case 'bytes: no input is ever turned into a parsed result by trimming (the exact valid line passes only with exactly one final line feed)' ((ConvertFrom-RuntimeReport -Bytes ($good + [byte[]](10)) -ExitCode 2).Status -ceq 'parsed')

    # ---------------------------------------------------------------- consistency with the runtime exit code
    $incons = [ordered]@{
        'sealed end with exit code 1' = @('{"phase":"run","sealed":true,"terminationReason":"error"}', 1); 'sealed end with exit code 2' = @('{"phase":"run","sealed":true,"terminationReason":"error"}', 2)
        'unsealed end with exit code 0' = @('{"phase":"run","sealed":false,"started":true,"failure":"seal_failed"}', 0); 'unsealed end with exit code 2' = @('{"phase":"run","sealed":false,"started":true,"failure":"seal_failed"}', 2)
        'a refusal before the Run with exit code 0' = @('{"phase":"stage_b","refusals":[{"check":"io","code":"port_failed"}]}', 0); 'a refusal before the Run with exit code 1' = @('{"phase":"input","code":"run_config_missing"}', 1)
        'internal error with exit code 2' = @('{"phase":"internal","code":"internal_error"}', 2); 'internal error with exit code 0' = @('{"phase":"internal","code":"internal_error"}', 0)
        'compose refusal with exit code 1' = @('{"phase":"compose","code":"manifest_port_refused"}', 1); 'a normal sealed end with exit code 1' = @('{"phase":"run","sealed":true,"terminationReason":"no_further_experiments"}', 1)
    }
    foreach ($k in $incons.Keys) { $x = Get-Report $incons[$k][0] $incons[$k][1]; Test-Case "consistency: $k is runtime_report_inconsistent, not eligible for complete, Launcher exit code 1" ($x.Status -ceq 'parsed' -and $x.Consistency -ceq 'inconsistent' -and $x.Classification -ceq 'runtime_report_inconsistent' -and -not $x.CompleteEligible -and $x.LauncherExitCode -eq 1) "$($x.Classification)" }
    foreach ($e in 3, 125, 126, 127, 137, 139, 143, 255, -1) {
        $x = Get-Report '{"phase":"run","sealed":true,"terminationReason":"iteration_limit_reached"}' $e
        $z = ConvertFrom-RuntimeReport -Bytes $null -ExitCode $e
        Test-Case "consistency: runtime exit code $e is runtime_exit_unexpected (with a valid sealed line and with no line), never eligible for complete" ($x.Classification -ceq 'runtime_exit_unexpected' -and $z.Classification -ceq 'runtime_exit_unexpected' -and -not $x.CompleteEligible -and -not $z.CompleteEligible -and $x.LauncherExitCode -eq 1)
    }
    foreach ($e in 0, 1, 2) { $z = ConvertFrom-RuntimeReport -Bytes $null -ExitCode $e; Test-Case "consistency: exit code $e without a line is runtime_report_invalid (an exit code alone does not prove a seal)" ($z.Classification -ceq 'runtime_report_invalid' -and -not $z.CompleteEligible -and $z.LauncherExitCode -eq 1 -and $z.Status -ceq 'absent') }

    # ---------------------------------------------------------------- nothing that the runtime wrote is returned when it is refused
    $hostile = @(
        ('{"phase":"input","code":"' + $marker + '"}'), ('{"' + $marker + '":"x"}'), ('{"phase":"' + $marker + '"}'), ('{"phase":"run","sealed":true,"terminationReason":"' + $marker + '"}'),
        ('{"phase":"run","sealed":false,"started":true,"failure":"' + $marker + '"}'), ('{"phase":"stage_a","codes":["' + $marker + '"]}'), ('{"phase":"stage_b","refusals":[{"check":"' + $marker + '","code":"port_failed"}]}'),
        ('{"phase":"stage_b","refusals":[{"check":"io","code":"port_failed","' + $marker + '":"x"}]}'), ('{"phase":"input","code":"run_config_missing","timers":["' + $marker + '"]}'), ('Error: ' + $marker),
        ('{"phase":"input","code":"' + $marker + '"'), ('{"phase":"input","code":["' + $marker + '"]}'), ('["' + $marker + '"]')
    )
    $leaks = @(); $outside = @()
    foreach ($h in $hostile) {
        foreach ($e in 0, 1, 2) {
            $x = Get-Report $h $e
            if ((ConvertTo-Json -InputObject $x -Depth 6) -match [regex]::Escape($marker)) { $leaks += $h }
            if ($x.Status -cne 'invalid' -and $x.Status -cne 'absent') { $outside += $h }
            if ($null -ne $x.ReportCode -and $reportCodes -cnotcontains $x.ReportCode) { $outside += "code:$($x.ReportCode)" }
        }
    }
    Test-Case 'no leak: for 13 hostile lines and the three exit codes the result is invalid and no text, key, or value of the line is in the result' ($leaks.Count -eq 0 -and $outside.Count -eq 0) (($leaks + $outside) -join ' || ')
    $codesInModule = @([regex]::Matches((Get-CodeOnly ([IO.File]::ReadAllText((Join-Path $script:ToolsDir 'RuntimeReport.psm1')))), "'(report_[a-z0-9_]+)'") | ForEach-Object { $_.Groups[1].Value } | Select-Object -Unique)
    Test-Case 'no leak: the reason codes of the module are exactly the closed list of nine' (Test-SameSet $codesInModule $reportCodes) ($codesInModule -join ',')
    $parsedLine = Get-Report '{"phase":"run","sealed":false,"started":true,"failure":"seal_failed","terminationReason":"error","timers":["timers_left"]}' 1
    Test-Case 'parsed result: only closed vocabulary values and booleans are returned' ($parsedLine.Phase -ceq 'run' -and $parsedLine.Sealed -eq $false -and $parsedLine.Started -eq $true -and $parsedLine.Failure -ceq 'seal_failed' -and $parsedLine.TerminationReason -ceq 'error' -and (@($parsedLine.Timers) -join ',') -ceq 'timers_left')
    $sb = Get-Report '{"phase":"stage_b","refusals":[{"check":"config","code":"config_not_validated"},{"check":"io","code":"io_unreadable"}]}' 2
    Test-Case 'parsed result: stage_b refusals are returned as check and code pairs in the order written' (@($sb.Refusals).Count -eq 2 -and $sb.Refusals[0].Check -ceq 'config' -and $sb.Refusals[1].Code -ceq 'io_unreadable')

    # ---------------------------------------------------------------- static checks of the module
    $code = Get-CodeOnly ([IO.File]::ReadAllText((Join-Path $script:ToolsDir 'RuntimeReport.psm1')))
    Test-Case 'static: the module calls no Docker, starts no process, reads and writes no file, writes no host output, and reads no environment variable' (-not ($code -match '(?i)docker|ProcessStartInfo|Start-Process|Invoke-Expression|Out-File|Set-Content|Add-Content|Get-Content|\[System\.IO\.File\]|\[IO\.File\]|Write-Host|\$env:|Invoke-WebRequest|Invoke-RestMethod'))
    Test-Case 'static: the module imports only DiscoveryCommon (the strict JSON reader) and exports three functions' ((@([regex]::Matches($code, 'Import-Module [^\r\n]+') | ForEach-Object { $_.Value }).Count) -eq 1 -and $code.Contains("'DiscoveryCommon.psm1'") -and $code.Contains('Export-ModuleMember -Function Get-RuntimeReportVocabulary, Get-RuntimeTerminationClass, ConvertFrom-RuntimeReport'))
    $launcherText = [IO.File]::ReadAllText((Join-Path $script:ToolsDir 'DiscoveryLauncher.psm1'))
    Test-Case 'static (C2): the Launcher imports this module and classifies the captured line with ConvertFrom-RuntimeReport; the entry point does not parse it itself' ($launcherText.Contains("Import-Module (Join-Path `$PSScriptRoot 'RuntimeReport.psm1')") -and $launcherText.Contains('ConvertFrom-RuntimeReport -Bytes $cap.Stderr -ExitCode $code') -and -not ([IO.File]::ReadAllText((Join-Path $script:ToolsDir 'Start-DiscoveryRun.ps1'))).Contains('ConvertFrom-RuntimeReport'))
}