$ErrorActionPreference = 'Stop'

$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$launcher = Join-Path $repoRoot 'infra\launcher'
$scripts = @('install-desktop.ps1', 'console.ps1')
$expectedExpression = "Resolve-Path (Join-Path `$PSScriptRoot '..\..\')"

foreach ($scriptName in $scripts) {
    $scriptPath = Join-Path $launcher $scriptName
    $content = Get-Content -LiteralPath $scriptPath -Raw

    if (-not $content.Contains($expectedExpression)) {
        throw "$scriptName must resolve the repository root exactly two levels above infra\launcher"
    }
}

$consolePath = Join-Path $launcher 'console.ps1'
$startPath = Join-Path $launcher 'start-demo.ps1'

if (-not (Test-Path -LiteralPath $consolePath -PathType Leaf)) {
    throw "Console entry point does not exist: $consolePath"
}

if (-not (Test-Path -LiteralPath $startPath -PathType Leaf)) {
    throw "Launcher entry point does not exist: $startPath"
}

$psi = New-Object System.Diagnostics.ProcessStartInfo
$psi.FileName = "$env:SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe"
$psi.Arguments = "-NoProfile -STA -ExecutionPolicy Bypass -File `"$consolePath`""
$psi.WorkingDirectory = $launcher
$psi.UseShellExecute = $false
$psi.RedirectStandardOutput = $true
$psi.RedirectStandardError = $true
$psi.CreateNoWindow = $true

$process = [System.Diagnostics.Process]::Start($psi)
if ($process.WaitForExit(2000)) {
    $stderr = $process.StandardError.ReadToEnd()
    throw "Console exited during startup with code $($process.ExitCode): $stderr"
}

$process.Kill()
$process.WaitForExit()

Write-Output 'PASS: launcher paths resolve correctly and the console remains open after startup'
