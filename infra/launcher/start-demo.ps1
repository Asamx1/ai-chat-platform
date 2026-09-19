# B1 启动编排脚本 —— 严格按 orchestrator-spec（launcher-b1-engine）实现
# 用法: powershell -File start-demo.ps1 [-Json] [-RepoRoot <path>]
# 退出码: 0 成功 / 1 失败 / 2 取消(Ctrl+C) / 3 忙（另一实例启动中）
[CmdletBinding()]
param(
    [switch]$Json,
    [string]$RepoRoot
)

$ErrorActionPreference = 'Stop'

# ---------- 基础路径 ----------
$r = if ($RepoRoot) { (Resolve-Path $RepoRoot).Path } else { (Resolve-Path (Join-Path $PSScriptRoot '..\..\')).Path }
$d = Join-Path $env:TEMP 'aichat-demo'
if (-not (Test-Path $d)) { New-Item -ItemType Directory -Path $d -Force | Out-Null }
$logPath = Join-Path $d 'launcher.log'
$composeFile = Join-Path $r 'infra\compose.yaml'
$composeArgs = @('compose', '-f', $composeFile, '--env-file', (Join-Path $r '.env'))

$script:ExitCode = 0
$script:Started = @{ worker = $false; web = $false; containers = $false }  # 本轮已启动标记（回滚仅处理已启动项）
$script:LockFile = $null

# ---------- 日志（同时 stdout + AppendAllText UTF8，避免 Tee-Object 编码问题） ----------
function Write-Log {
    param([string]$Level, [string]$Step, [string]$Message)
    $ts = (Get-Date).ToString('yyyy-MM-dd HH:mm:ss')
    $line = "[$ts] [$Level] $Message"
    Write-Host $line
    [IO.File]::AppendAllText($logPath, $line + [Environment]::NewLine, [Text.Encoding]::UTF8)
    if ($Json) {
        $state = @{ 'OK' = 'ok'; 'WAIT' = 'wait'; 'FAIL' = 'fail' }[$Level]
        Write-Output ('{ "step": ' + (ConvertTo-Json $Step -Compress) + ', "state": ' + (ConvertTo-Json $state -Compress) + ', "message": ' + (ConvertTo-Json $Message -Compress) + ' }')
    }
}

function Fail {
    param([string]$Step, [string]$Message)
    Write-Log 'FAIL' $Step $Message
    Rollback
    $script:ExitCode = 1
    exit $script:ExitCode
}

# Ctrl+C：PS 5.1 下事件回调运行在独立 runspace、无法可靠回滚——取消时依赖 finally 清锁，
# 由用户手动执行 stop-demo.ps1（或 docker compose stop）完成回滚；退出码 2（取消）为尽力语义。

# ---------- 回滚：worker → web → 容器（仅本轮已启动项） ----------
function Stop-ByPidFile {
    param([string]$Name)  # 'web' | 'worker'
    $pidFile = Join-Path $d "$Name.pid"
    if (Test-Path $pidFile) {
        $p = (Get-Content $pidFile -ErrorAction SilentlyContinue) -as [int]
        if ($p) {
            # cmd /c 启动 pnpm(bat) → 进程树 cmd→node：先 taskkill /T /F 兜底再 Stop-Process
            taskkill /PID $p /T /F 2>$null | Out-Null
            try { Stop-Process -Id $p -Force -ErrorAction SilentlyContinue } catch {}
        }
        Remove-Item $pidFile -Force -ErrorAction SilentlyContinue
        Remove-Item "$pidFile.time" -Force -ErrorAction SilentlyContinue
    }
    # 端口兜底
    $port = if ($Name -eq 'web') { 3100 } else { $null }
    if ($port) {
        Get-NetTCPConnection -LocalPort $port -ErrorAction SilentlyContinue |
            Where-Object { $_.State -eq 'Listen' } |
            ForEach-Object { taskkill /PID $_.OwningProcess /T /F 2>$null | Out-Null }
    }
}

function Rollback {
    if ($script:Started.worker) { Write-Log 'OK' 'S4' '回滚: 停止 worker'; Stop-ByPidFile 'worker' }
    if ($script:Started.web)    { Write-Log 'OK' 'S3' '回滚: 停止 web';    Stop-ByPidFile 'web' }
    if ($script:Started.containers) {
        Write-Log 'OK' 'S1' '回滚: docker compose stop（保留数据卷）'
        & docker @composeArgs stop 2>&1 | Out-Null
    }
}

# ---------- 启停互斥 ----------
$script:LockFile = Join-Path $d 'starting.lock'
if (Test-Path $script:LockFile) {
    Write-Log 'FAIL' 'S0' '另一实例正在启动（starting.lock 存在），退出。请稍后重试或运行 stop-demo.ps1 清理。'
    exit 3
}
New-Item -ItemType File -Path $script:LockFile -Force | Out-Null

try {
    # ---------- .env ----------
    $envFile = Join-Path $r '.env'
    if (-not (Test-Path $envFile)) { Fail 'ENV' "未找到 $envFile" }
    Get-Content $envFile | ForEach-Object {
        $line = $_.Trim()
        if ($line -eq '' -or $line.StartsWith('#')) { return }
        $idx = $line.IndexOf('=')
        if ($idx -lt 1) { return }
        $k = $line.Substring(0, $idx).Trim()
        $v = $line.Substring($idx + 1).Trim()
        [Environment]::SetEnvironmentVariable($k, $v, 'Process')
    }
    if ([string]::IsNullOrWhiteSpace($env:BETTER_AUTH_SECRET)) {
        Fail 'ENV' 'BETTER_AUTH_SECRET 为空：请在 .env 设置 32+ 字节随机串（openssl rand -base64 32）'
    }
    $env:AICHAT_LOCAL_SMOKE = '1'
    $env:AICHAT_SECURE_COOKIES = '0'
    Write-Log 'OK' 'ENV' '.env 已加载（BETTER_AUTH_SECRET 非空；强制 AICHAT_LOCAL_SMOKE=1 / AICHAT_SECURE_COOKIES=0）'

    # ---------- S0: Docker daemon ----------
    Write-Log 'OK' 'S0' '检查 Docker daemon...'
    while ($true) {
        try {
            $ver = & docker info --format '{{.ServerVersion}}' 2>$null
            if ($LASTEXITCODE -eq 0 -and $ver) { break }
        } catch { }
        Write-Log 'WAIT' 'S0' 'Docker daemon 未就绪，请打开 Docker Desktop（每 2s 重试，Ctrl+C 退出）'
        Start-Sleep -Seconds 2
    }
    Write-Log 'OK' 'S0' "Docker daemon 在线（ServerVersion=$ver）"

    # ---------- S1: compose up + 等三容器 healthy ----------
    # docker 把进度写 stderr（NativeCommandError 陷阱）：临时放宽并重定向
    $prevEAP = $ErrorActionPreference; $ErrorActionPreference = 'Continue'
    & docker @composeArgs up -d 2>&1 | ForEach-Object { Write-Host "  $_" }
    $ErrorActionPreference = $prevEAP
    if ($LASTEXITCODE -ne 0) { Fail 'S1' 'docker compose up -d 失败' }
    $script:Started.containers = $true
    $required = @('aichat-postgres', 'aichat-redis', 'aichat-minio')
    $deadline = (Get-Date).AddSeconds(120)
    while ($true) {
        $names = @(& docker ps --filter 'name=aichat' --filter 'health=healthy' --format '{{.Names}}' 2>$null)
        $missing = @($required | Where-Object { $names -notcontains $_ })
        if ($missing.Count -eq 0) { break }
        if ((Get-Date) -gt $deadline) { Fail 'S1' "容器健康检查 120s 超时，未就绪: $($missing -join ', ')" }
        Write-Log 'WAIT' 'S1' "等待容器 healthy（缺: $($missing -join ', ')）"
        Start-Sleep -Seconds 3
    }
    Write-Log 'OK' 'S1' '三容器 healthy: aichat-postgres / aichat-redis / aichat-minio'

    # ---------- S2: Ollama 在线 + 三模型并行预热 ----------
    try {
        $tags = Invoke-RestMethod -Uri 'http://127.0.0.1:11434/api/tags' -TimeoutSec 2
    } catch {
        Fail 'S2' 'Ollama 不在线（127.0.0.1:11434 无响应），请启动 Ollama'
    }
    Write-Log 'OK' 'S2' "Ollama 在线，已装模型 $($tags.models.Count) 个"
    $models = @('qwen3:8b', 'qwen2.5:7b', 'qwen3:0.6b')
    $jobs = $models | ForEach-Object {
        $m = $_
        Start-Job -Name "warm-$($m -replace '[:.]','_')" -ScriptBlock {
            param($m)
            $body = @{ model = $m; messages = @(@{ role = 'user'; content = 'hi' }); stream = $false; options = @{ num_predict = 1 } } | ConvertTo-Json -Depth 5
            Invoke-RestMethod -Uri 'http://127.0.0.1:11434/api/chat' -Method Post -Body $body -ContentType 'application/json' -TimeoutSec 60
        } -ArgumentList $m
    }
    Write-Log 'WAIT' 'S2' "三模型并行预热（num_predict=1，60s 超时）: $($models -join ' / ')"
    $failed = @()
    foreach ($j in $jobs) {
        try {
            $null = $j | Wait-Job -Timeout 70
            if ($j.State -eq 'Failed') { $failed += $j.Name; continue }
            $null = $j | Receive-Job -Wait -ErrorAction Stop
        } catch { $failed += $j.Name }
    }
    $jobs | Remove-Job -Force -ErrorAction SilentlyContinue
    if ($failed.Count -gt 0) {
        Fail 'S2' "模型预热失败: $($failed -join ', ')（已回滚 compose stop）"
    }
    Write-Log 'OK' 'S2' '三模型预热完成（已驻留显存/内存）'

    # ---------- S3: Web（next start -p 3100） ----------
    $env:Path += ';C:\Program Files\nodejs'
    Get-NetTCPConnection -LocalPort 3100 -ErrorAction SilentlyContinue |
        Where-Object { $_.State -eq 'Listen' } |
        ForEach-Object { taskkill /PID $_.OwningProcess /T /F 2>$null | Out-Null }
    $web = Start-Process -FilePath $env:ComSpec -ArgumentList '/d', '/c', 'pnpm exec next start -p 3100' `
        -WorkingDirectory (Join-Path $r 'apps\web') -WindowStyle Hidden -PassThru
    $script:Started.web = $true
    Set-Content -Path (Join-Path $d 'web.pid') -Value $web.Id -Encoding ASCII
    [IO.File]::WriteAllText((Join-Path $d 'web.pid.time'), $web.StartTime.ToString('o'))
    $u = 'http://127.0.0.1:3100'
    $deadline = (Get-Date).AddSeconds(30); $webOk = $false
    while ((Get-Date) -lt $deadline) {
        try {
            $resp = Invoke-WebRequest -Uri $u -UseBasicParsing -TimeoutSec 3
            if ($resp.StatusCode -eq 200) { $webOk = $true; break }
        } catch { Start-Sleep -Seconds 2 }
    }
    if (-not $webOk) { Fail 'S3' "Web 30s 内未返回 200（$u），PID=$($web.Id)" }
    Write-Log 'OK' 'S3' "Web 已启动 $u（PID=$($web.Id)）"

    # ---------- S4: Worker ----------
    $wk = Start-Process -FilePath $env:ComSpec -ArgumentList '/d', '/c', 'pnpm exec tsx src/main.ts' `
        -WorkingDirectory (Join-Path $r 'apps\worker') -WindowStyle Hidden -PassThru
    $script:Started.worker = $true
    Set-Content -Path (Join-Path $d 'worker.pid') -Value $wk.Id -Encoding ASCII
    [IO.File]::WriteAllText((Join-Path $d 'worker.pid.time'), $wk.StartTime.ToString('o'))
    Start-Sleep -Seconds 3
    try { $null = Get-Process -Id $wk.Id -ErrorAction Stop } catch {
        Fail 'S4' "Worker 启动后 3s 内退出（PID=$($wk.Id)），请查看 worker 日志"
    }
    Write-Log 'OK' 'S4' "Worker 已启动（PID=$($wk.Id)，存活>3s）"

    # ---------- S5: 打开浏览器 ----------
    Start-Process 'http://127.0.0.1:3100'
    Write-Log 'OK' 'S5' '已打开浏览器 http://127.0.0.1:3100'

    Write-Log 'OK' 'done' '启动完成'
    if ($Json) { Write-Output '{ "step": "done", "state": "ok" }' }
    exit 0
}
finally {
    if ($script:LockFile -and (Test-Path $script:LockFile)) { Remove-Item $script:LockFile -Force -ErrorAction SilentlyContinue }
}
