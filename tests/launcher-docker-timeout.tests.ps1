$ErrorActionPreference = 'Stop'

$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$scriptPath = Join-Path $repoRoot 'infra\launcher\start-demo.ps1'
$hostTemp = $env:TEMP
$livePidPath = Join-Path $hostTemp 'aichat-demo\web.pid'
$liveWebPid = if (Test-Path -LiteralPath $livePidPath) {
    (Get-Content -LiteralPath $livePidPath -Raw).Trim() -as [int]
} else {
    $null
}
$listenerPattern = '^\s*TCP\s+\S+:3100\s+\S+\s+LISTENING\s+(\d+)\s*$'
$livePortOwner = @(netstat -ano | Select-String $listenerPattern | ForEach-Object {
    [int]$_.Matches[0].Groups[1].Value
} | Select-Object -Unique) | Select-Object -First 1
$testTemp = Join-Path $hostTemp "aichat-launcher-timeout-test-$PID"
$shimBin = Join-Path $testTemp 'bin'
$missingDockerDesktop = Join-Path $testTemp 'missing-docker-desktop.exe'
New-Item -ItemType Directory -Path $shimBin -Force | Out-Null

# Force the child launcher to observe Docker as unavailable even if the host daemon is healthy.
# TEMP/TMP isolate launcher PID, log, and lock files from the live app.
$dockerShim = Join-Path $shimBin 'docker.cmd'
[IO.File]::WriteAllText($dockerShim, "@exit /b 1`r`n", [Text.Encoding]::ASCII)
$psi = New-Object System.Diagnostics.ProcessStartInfo
$psi.FileName = "$env:SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe"
$psi.Arguments = "-NoProfile -ExecutionPolicy Bypass -File `"$scriptPath`" -RepoRoot `"$repoRoot`" -DockerReadyTimeoutSeconds 1 -DockerDesktopPath `"$missingDockerDesktop`""
$psi.WorkingDirectory = $repoRoot
$psi.UseShellExecute = $false
$psi.RedirectStandardOutput = $true
$psi.RedirectStandardError = $true
$psi.CreateNoWindow = $true
$psi.EnvironmentVariables['TEMP'] = $testTemp
$psi.EnvironmentVariables['TMP'] = $testTemp
$psi.EnvironmentVariables['PATH'] = "$shimBin;$env:SystemRoot\System32;$env:SystemRoot;$env:SystemRoot\System32\WindowsPowerShell\v1.0"

$process = $null
$stopwatch = [Diagnostics.Stopwatch]::StartNew()

try {
    $process = [Diagnostics.Process]::Start($psi)
    if (-not $process.WaitForExit(8000)) {
        if (-not $process.HasExited) {
            taskkill /PID $process.Id /T /F 2>$null | Out-Null
            $null = $process.WaitForExit(2000)
        }
        throw "Isolated launcher did not exit within 8 seconds; its process tree was terminated"
    }
    $stopwatch.Stop()
    $exitCode = $process.ExitCode
    $output = $process.StandardOutput.ReadToEnd() + $process.StandardError.ReadToEnd()

    if ($exitCode -ne 1) {
        throw "Expected exit code 1 when Docker is unavailable, got $exitCode"
    }

    if ($stopwatch.Elapsed.TotalSeconds -gt 5) {
        throw "Docker readiness failure exceeded 5 seconds: $($stopwatch.Elapsed.TotalSeconds)"
    }

    if ($output -notmatch 'Docker daemon.*1s') {
        throw "Expected a bounded Docker timeout message, got: $output"
    }

    $isolatedRunDir = Join-Path $testTemp 'aichat-demo'
    if ((Test-Path -LiteralPath (Join-Path $isolatedRunDir 'web.pid')) -or
        (Test-Path -LiteralPath (Join-Path $isolatedRunDir 'worker.pid'))) {
        throw "Launcher progressed beyond the isolated Docker readiness check"
    }

    if ($liveWebPid) {
        $liveWebPidAfter = (Get-Content -LiteralPath $livePidPath -Raw).Trim() -as [int]
        if ($liveWebPidAfter -ne $liveWebPid) {
            throw "Live web PID changed: before=$liveWebPid after=$liveWebPidAfter"
        }
    }

    if ($livePortOwner) {
        $livePortOwnerAfter = @(netstat -ano | Select-String $listenerPattern | ForEach-Object {
            [int]$_.Matches[0].Groups[1].Value
        } | Select-Object -Unique) | Select-Object -First 1
        if ($livePortOwnerAfter -ne $livePortOwner) {
            throw "Live port-3100 owner changed: before=$livePortOwner after=$livePortOwnerAfter"
        }
        try {
            $null = Get-Process -Id $livePortOwner -ErrorAction Stop
        } catch {
            throw "Live port-3100 owner $livePortOwner was stopped by the isolated timeout test"
        }
    }

    Write-Output "PASS: isolated Docker-unavailable startup exits in $([math]::Round($stopwatch.Elapsed.TotalSeconds, 2))s; live port-3100 owner unchanged ($livePortOwner)"
} finally {
    $stopwatch.Stop()
    if ($process -and -not $process.HasExited) {
        taskkill /PID $process.Id /T /F 2>$null | Out-Null
        $null = $process.WaitForExit(2000)
    }
    if (Test-Path -LiteralPath $testTemp) {
        Remove-Item -LiteralPath $testTemp -Recurse -Force
    }
}
