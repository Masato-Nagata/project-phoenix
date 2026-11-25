#Requires -Version 7.0
# Static check of infra/discovery/runtime.Dockerfile (task 4.9-E2). Text only: no Docker, no build, no network, no file is written.
# It checks that the RUNTIME stage copies exactly an explicit list of files (per package: package.json and dist; plus the baked data of
# verifier and discovery-loop; plus the root package.json and node_modules), all root-owned, that it never copies src, test, test-vectors,
# fixtures or tsconfig, never copies all of /build/packages, and never deletes after a copy; and that the user, the entry point and the pinned
# base image digest are kept. The BUILD stage is checked separately: it keeps copying the sources it needs to compile.
# Comments are not instructions: the parser skips them (a commented COPY line is never counted). Line continuations are joined first.
# Every rule has a positive control that runs the same checker on a deliberately defective Dockerfile text and expects the defect to be named.
# It cannot prove the contents of a built image (that is measured on the built image); it proves what the Dockerfile asks for.
. (Join-Path $PSScriptRoot 'lib/testlib.ps1')

$script:BaseDigest = 'sha256:5adad64f9a1fca2d51972caa65983634c8a774eb300d72b20f7f2a0f60368072'
$script:BaseImage = 'docker.io/library/node:26.13.0-trixie-slim@' + $script:BaseDigest
# The complete list of what the runtime stage may copy: source in the build stage | destination in the image.
$script:AllowedRuntimeCopies = @(
    '/build/package.json|./package.json',
    '/build/node_modules|./node_modules',
    '/build/packages/ai-client/package.json|./packages/ai-client/package.json',
    '/build/packages/ai-client/dist|./packages/ai-client/dist',
    '/build/packages/analyzer/package.json|./packages/analyzer/package.json',
    '/build/packages/analyzer/dist|./packages/analyzer/dist',
    '/build/packages/verifier/package.json|./packages/verifier/package.json',
    '/build/packages/verifier/dist|./packages/verifier/dist',
    '/build/packages/verifier/data|./packages/verifier/data',
    '/build/packages/discovery-loop/package.json|./packages/discovery-loop/package.json',
    '/build/packages/discovery-loop/dist|./packages/discovery-loop/dist',
    '/build/packages/discovery-loop/data|./packages/discovery-loop/data'
)

# Instructions of a Dockerfile text: comment and blank lines skipped, continuation lines joined. Result: @{ Op; Args }.
function Get-DockerInstructions {
    param([string]$Text)
    $out = [System.Collections.Generic.List[object]]::new()
    $buf = $null
    foreach ($raw in ($Text -split "\r?\n")) {
        $t = $raw.Trim()
        if ($t -eq '' -or $t.StartsWith('#')) { continue }
        $buf = if ($null -eq $buf) { $t } else { $buf + ' ' + $t }
        if ($buf.EndsWith('\')) { $buf = $buf.Substring(0, $buf.Length - 1).TrimEnd(); continue }
        $m = [regex]::Match($buf, '^(\S+)\s*(.*)$')
        $out.Add([pscustomobject]@{ Op = $m.Groups[1].Value.ToUpperInvariant(); Args = $m.Groups[2].Value })
        $buf = $null
    }
    $out.ToArray()
}

# Global instructions (before the first FROM) and the stages.
function Get-DockerModel {
    param([string]$Text)
    $globals = [System.Collections.Generic.List[object]]::new()
    $stages = [System.Collections.Generic.List[object]]::new()
    foreach ($i in (Get-DockerInstructions -Text $Text)) {
        if ($i.Op -ceq 'FROM') {
            $m = [regex]::Match($i.Args, '^(\S+)(?:\s+(?i:AS)\s+(\S+))?\s*$')
            $stages.Add([pscustomobject]@{ Image = $m.Groups[1].Value; Name = $m.Groups[2].Value; Instr = [System.Collections.Generic.List[object]]::new() })
        } elseif ($stages.Count -eq 0) { $globals.Add($i) } else { $stages[$stages.Count - 1].Instr.Add($i) }
    }
    [pscustomobject]@{ Globals = $globals.ToArray(); Stages = $stages.ToArray() }
}

function ConvertFrom-CopyArgs {
    param([string]$CopyArgs)
    $flags = @{}; $paths = [System.Collections.Generic.List[string]]::new()
    foreach ($tok in ($CopyArgs -split '\s+' | Where-Object { $_ -ne '' })) {
        if ($tok.StartsWith('--')) { $kv = $tok.Substring(2).Split('=', 2); $flags[$kv[0]] = if ($kv.Count -gt 1) { $kv[1] } else { '' } } else { $paths.Add($tok) }
    }
    $dest = if ($paths.Count -gt 0) { $paths[$paths.Count - 1] } else { '' }
    $srcs = if ($paths.Count -gt 1) { @($paths[0..($paths.Count - 2)]) } else { @() }
    [pscustomobject]@{ From = [string]$flags['from']; Chown = [string]$flags['chown']; Sources = $srcs; Dest = $dest; Json = ($CopyArgs.TrimStart().StartsWith('[')) }
}

# The closed list of problem codes of a Dockerfile text. An empty result means that the contract holds.
function Get-RuntimeDockerfileProblems {
    param([string]$Text)
    $p = [System.Collections.Generic.List[string]]::new()
    $model = Get-DockerModel -Text $Text
    $stages = @($model.Stages)
    if ($stages.Count -ne 2 -or $stages[0].Name -cne 'build' -or $stages[1].Name -cne 'runtime') { return @('stages') }
    $build = $stages[0]; $rt = $stages[1]
    # pinned base image: the ARG default is the exact pinned reference, and both stages start from it
    $arg = @($model.Globals | Where-Object { $_.Op -ceq 'ARG' -and $_.Args -cmatch '^BASE_IMAGE=' })
    if ($arg.Count -ne 1 -or $arg[0].Args -cne ('BASE_IMAGE=' + $script:BaseImage)) { $p.Add('base_digest') }
    if ($build.Image -cne '${BASE_IMAGE}' -or $rt.Image -cne '${BASE_IMAGE}') { $p.Add('base_from') }
    # build stage: the sources needed to compile are copied (this is NOT restricted)
    $bc = @($build.Instr | Where-Object { $_.Op -ceq 'COPY' } | ForEach-Object { ConvertFrom-CopyArgs -CopyArgs $_.Args })
    if (@($bc | Where-Object { $_.From -ceq '' -and $_.Dest -ceq './packages/' -and @($_.Sources) -ceq 'packages/' }).Count -ne 1) { $p.Add('build_sources') }
    # runtime stage COPY list
    $copies = @($rt.Instr | Where-Object { $_.Op -ceq 'COPY' } | ForEach-Object { ConvertFrom-CopyArgs -CopyArgs $_.Args })
    $seen = [System.Collections.Generic.List[string]]::new()
    foreach ($c in $copies) {
        if ($c.Json -or @($c.Sources).Count -ne 1) { $p.Add('copy_form'); continue }
        $src = [string]@($c.Sources)[0]
        $seen.Add("$src|$($c.Dest)")
        if ($c.From -cne 'build') { $p.Add('copy_from') }
        if ($c.Chown -cne '0:0') { $p.Add('copy_chown') }
        if ($src -cmatch '[*?\[]') { $p.Add('copy_wildcard') }
        if ($src -cmatch '^/build/?$' -or $src -cmatch '^/build/packages/?$' -or $src -cmatch '^\.' ) { $p.Add('copy_whole_packages') }
        if ($src -cmatch '(^|/)(src|test|tests|test-vectors|fixtures|evaluation|tsconfig[^/]*\.json)(/|$)') { $p.Add('copy_unneeded') }
    }
    if ((($seen | Sort-Object) -join "`n") -cne (($script:AllowedRuntimeCopies | Sort-Object) -join "`n")) { $p.Add('copy_list') }
    # no deletion after a copy (a lower layer would keep the file)
    foreach ($r in @($rt.Instr | Where-Object { $_.Op -ceq 'RUN' })) { if ($r.Args -cmatch '(^|[\s;&|])(rm|unlink|shred)\s|-delete\b') { $p.Add('delete_after_copy') } }
    # user, entry point, working directory, environment
    $users = @($rt.Instr | Where-Object { $_.Op -ceq 'USER' })
    if ($users.Count -lt 1 -or $users[$users.Count - 1].Args -cne '10001:10001') { $p.Add('user') }
    $ep = @($rt.Instr | Where-Object { $_.Op -ceq 'ENTRYPOINT' })
    if ($ep.Count -ne 1 -or $ep[0].Args -cne '["node", "/app/packages/discovery-loop/dist/main.js"]') { $p.Add('entrypoint') }
    $wd = @($rt.Instr | Where-Object { $_.Op -ceq 'WORKDIR' })
    if ($wd.Count -ne 1 -or $wd[0].Args -cne '/app') { $p.Add('workdir') }
    $env = @($rt.Instr | Where-Object { $_.Op -ceq 'ENV' })
    if ($env.Count -ne 1 -or $env[0].Args -cne 'NODE_ENV=production NPM_CONFIG_UPDATE_NOTIFIER=false') { $p.Add('env') }
    @($p.ToArray() | Select-Object -Unique)
}

function Set-DockerfileText {
    param([string]$Text, [string]$Old, [string]$New)
    if (-not $Text.Contains($Old)) { throw "control anchor missing: $Old" }
    $Text.Replace($Old, $New)
}

Invoke-TestMain {
    Write-Host '=== runtime.Dockerfile static check (task 4.9-E2): text only ===' -ForegroundColor Cyan
    $path = Join-Path $script:RepoRoot 'infra/discovery/runtime.Dockerfile'
    $real = [IO.File]::ReadAllText($path)
    $probs = @(Get-RuntimeDockerfileProblems -Text $real)
    Test-Case 'the runtime Dockerfile satisfies the whole contract (no problem code)' ($probs.Count -eq 0) ($probs -join ',')

    $model = Get-DockerModel -Text $real
    $rt = @($model.Stages)[1]
    $copies = @($rt.Instr | Where-Object { $_.Op -ceq 'COPY' } | ForEach-Object { ConvertFrom-CopyArgs -CopyArgs $_.Args })
    Test-Case 'two stages named build and runtime' (@($model.Stages).Count -eq 2 -and @($model.Stages)[0].Name -ceq 'build' -and @($model.Stages)[1].Name -ceq 'runtime')
    Test-Case 'the runtime stage has exactly 12 COPY instructions' ($copies.Count -eq 12) "$($copies.Count)"
    Test-Case 'the runtime COPY list equals the explicit allowed list' ((($copies | ForEach-Object { "$(@($_.Sources)[0])|$($_.Dest)" } | Sort-Object) -join "`n") -ceq (($script:AllowedRuntimeCopies | Sort-Object) -join "`n"))
    Test-Case 'every runtime COPY is from the build stage and root-owned (--chown=0:0)' (@($copies | Where-Object { $_.From -cne 'build' -or $_.Chown -cne '0:0' }).Count -eq 0)
    Test-Case 'no runtime COPY names src, test, test-vectors, fixtures, evaluation, tsconfig, a wildcard, or all of /build/packages' (@($copies | Where-Object { @($_.Sources)[0] -cmatch '(^|/)(src|test|tests|test-vectors|fixtures|evaluation|tsconfig[^/]*\.json)(/|$)|[*?\[]|^/build/?$|^/build/packages/?$' }).Count -eq 0)
    Test-Case 'the build stage still copies the sources it needs (COPY packages/ ./packages/, not from another stage); the runtime restriction does not apply to it' (@($probs) -cnotcontains 'build_sources')
    Test-Case 'the runtime stage has no RUN that deletes' (@($rt.Instr | Where-Object { $_.Op -ceq 'RUN' -and $_.Args -cmatch '(^|[\s;&|])(rm|unlink|shred)\s|-delete\b' }).Count -eq 0)
    Test-Case 'USER 10001:10001 is the last USER of the runtime stage' (@($rt.Instr | Where-Object { $_.Op -ceq 'USER' } | Select-Object -Last 1).Args -ceq '10001:10001')
    Test-Case 'ENTRYPOINT is node /app/packages/discovery-loop/dist/main.js' (@($rt.Instr | Where-Object { $_.Op -ceq 'ENTRYPOINT' }).Args -ceq '["node", "/app/packages/discovery-loop/dist/main.js"]')
    Test-Case 'the base image is the pinned digest reference and both stages use it' ((@($model.Globals | Where-Object { $_.Op -ceq 'ARG' }).Args -ceq ('BASE_IMAGE=' + $script:BaseImage)) -and @($model.Stages | Where-Object { $_.Image -ceq '${BASE_IMAGE}' }).Count -eq 2)

    # ---- positive controls: the same checker on deliberately defective texts must name the defect
    $a = 'COPY --from=build --chown=0:0 /build/packages/analyzer/dist ./packages/analyzer/dist'
    $m1 = Set-DockerfileText $real $a 'COPY --from=build --chown=0:0 /build/packages ./packages'
    $p1 = @(Get-RuntimeDockerfileProblems -Text $m1)
    Test-Case 'control: copying all of /build/packages is reported' ($p1 -contains 'copy_whole_packages' -and $p1 -contains 'copy_list') ($p1 -join ',')
    $m2 = Set-DockerfileText $real $a ($a + "`nCOPY --from=build --chown=0:0 /build/packages/verifier/src ./packages/verifier/src")
    $p2 = @(Get-RuntimeDockerfileProblems -Text $m2)
    Test-Case 'control: an added src COPY is reported' ($p2 -contains 'copy_unneeded' -and $p2 -contains 'copy_list') ($p2 -join ',')
    foreach ($d in 'test', 'test-vectors', 'fixtures') {
        $pd = @(Get-RuntimeDockerfileProblems -Text (Set-DockerfileText $real $a ($a + "`nCOPY --from=build --chown=0:0 /build/packages/analyzer/$d ./packages/analyzer/$d")))
        Test-Case "control: an added $d COPY is reported" ($pd -contains 'copy_unneeded' -and $pd -contains 'copy_list') ($pd -join ',')
    }
    $p3 = @(Get-RuntimeDockerfileProblems -Text (Set-DockerfileText $real $a 'COPY --from=build /build/packages/analyzer/dist ./packages/analyzer/dist'))
    Test-Case 'control: a COPY without --chown=0:0 is reported' ($p3 -contains 'copy_chown') ($p3 -join ',')
    $p3b = @(Get-RuntimeDockerfileProblems -Text (Set-DockerfileText $real $a 'COPY --from=build --chown=10001:10001 /build/packages/analyzer/dist ./packages/analyzer/dist'))
    Test-Case 'control: a COPY owned by the runtime user is reported' ($p3b -contains 'copy_chown') ($p3b -join ',')
    $p3c = @(Get-RuntimeDockerfileProblems -Text (Set-DockerfileText $real $a 'COPY --from=build --chown=0:0 /build/packages/*/dist ./packages/'))
    Test-Case 'control: a wildcard COPY is reported' ($p3c -contains 'copy_wildcard' -and $p3c -contains 'copy_list') ($p3c -join ',')
    $p4 = @(Get-RuntimeDockerfileProblems -Text (Set-DockerfileText $real 'LABEL phoenix.discovery.role="runtime"' "LABEL phoenix.discovery.role=`"runtime`"`nRUN rm -rf /app/packages/verifier/dist/probe"))
    Test-Case 'control: a deletion after the copy is reported' ($p4 -contains 'delete_after_copy') ($p4 -join ',')
    $p5 = @(Get-RuntimeDockerfileProblems -Text (Set-DockerfileText $real 'USER 10001:10001' 'USER root'))
    Test-Case 'control: a changed USER is reported' ($p5 -contains 'user') ($p5 -join ',')
    $p6 = @(Get-RuntimeDockerfileProblems -Text (Set-DockerfileText $real 'ENTRYPOINT ["node", "/app/packages/discovery-loop/dist/main.js"]' 'ENTRYPOINT ["node", "/app/packages/discovery-loop/dist/other.js"]'))
    Test-Case 'control: a changed ENTRYPOINT is reported' ($p6 -contains 'entrypoint') ($p6 -join ',')
    $p7 = @(Get-RuntimeDockerfileProblems -Text (Set-DockerfileText $real ('sha256:5adad64f9a1fca2d51972caa65983634c8a774eb300d72b20f7f2a0f60368072') ('sha256:' + ('0' * 64))))
    Test-Case 'control: a changed base digest is reported' ($p7 -contains 'base_digest') ($p7 -join ',')
    $p8 = @(Get-RuntimeDockerfileProblems -Text (Set-DockerfileText $real 'COPY packages/ ./packages/' '# COPY packages/ ./packages/'))
    Test-Case 'control: a missing build-stage source COPY is reported (the build stage is checked separately)' ($p8 -contains 'build_sources') ($p8 -join ',')
    $p9 = @(Get-RuntimeDockerfileProblems -Text ($real + "`n# COPY --from=build --chown=0:0 /build/packages ./packages`n"))
    Test-Case 'control: a COPY inside a comment is not an instruction and is not reported' ($p9.Count -eq 0) ($p9 -join ',')
    $cont = Get-DockerInstructions -Text "COPY --from=build \`n  --chown=0:0 /build/a ./a`n# COPY x y`n"
    Test-Case 'control: a continuation line is joined and a comment line is skipped' (@($cont).Count -eq 1 -and @($cont)[0].Args -ceq '--from=build --chown=0:0 /build/a ./a')
    Test-Case 'control: an unnamed or extra stage is reported' (@(Get-RuntimeDockerfileProblems -Text ($real + "`nFROM scratch AS extra`n")) -contains 'stages')
}