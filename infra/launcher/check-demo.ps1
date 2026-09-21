# B1 健康检查脚本 —— 按 orchestrator-spec（launcher-b1-engine）实现
# 用法: powershell -File check-demo.ps1 [-Json] [-RepoRoot <path>]
# 退出码: 0 全过 / 1 有 FAIL
[CmdletBinding()]
param(
    [switch]$Json,
    [string]$RepoRoot
)

$ErrorActionPreference = 'Continue'
$r = if ($RepoRoot) { (Resolve-Path $RepoRoot).Path } else { (Resolve-Path (Join-Path $PSScriptRoot '..\..\')).Path }
$d = Join-Path $env:TEMP 'aichat-demo'
$models = @('qwen3:8b', 'qwen2.5:7b', 'qwen3:0.6b')
$checks = [System.Collections.Generic.List[object]]::new()

function Add-Check {
    param([string]$Name, [string]$Desc, [ValidateSet('pass','fail','warn')] [string]$State, [string]$Hint)
    $checks.Add([pscustomobject]@{ name = $Name; desc = $Desc; state = $State; hint = $Hint })
}

# ① Docker daemon
try {
    $ver = & docker info --format '{{.ServerVersion}}' 2>$null
    if ($LASTEXITCODE -eq 0 -and $ver) {
        Add-Check 'docker' 'Docker daemon' 'pass' "ServerVersion=$ver"
    } else {
        Add-Check 'docker' 'Docker daemon' 'fail' '请打开 Docker Desktop 并等待其完全启动后重试'
    }
} catch {
    Add-Check 'docker' 'Docker daemon' 'fail' 'docker 命令不可用或 daemon 未运行：请打开 Docker Desktop'
}

# ② 三容器 healthy
$required = @('aichat-postgres', 'aichat-redis', 'aichat-minio')
try {
    $names = @(& docker ps --filter 'name=aichat' --filter 'health=healthy' --format '{{.Names}}' 2>$null)
    $missing = @($required | Where-Object { $names -notcontains $_ })
    if ($missing.Count -eq 0) {
        Add-Check 'containers' '三容器 healthy' 'pass' ''
    } else {
        Add-Check 'containers' '三容器 healthy' 'fail' ("未 healthy: " + ($missing -join ', ') + "。运行 start-demo.ps1，或手动 docker compose -f infra/compose.yaml up -d 后等待 healthcheck")
    }
} catch {
    Add-Check 'containers' '三容器 healthy' 'fail' 'docker ps 查询失败：确认 Docker 在线'
}

# ③ Ollama 在线 + 三模型在库
try {
    $tags = Invoke-RestMethod -Uri 'http://127.0.0.1:11434/api/tags' -TimeoutSec 2
    $installed = @($tags.models | ForEach-Object { $_.name })
    $missingModels = @($models | Where-Object { $installed -notcontains $_ })
    if ($missingModels.Count -eq 0) {
        Add-Check 'ollama-models' 'Ollama 在线 + 三模型在库' 'pass' ''
    } else {
        Add-Check 'ollama-models' 'Ollama 在线 + 三模型在库' 'fail' ("缺模型: " + ($missingModels -join ', ') + "。执行 ollama pull <model>")
    }
} catch {
    Add-Check 'ollama-models' 'Ollama 在线 + 三模型在库' 'fail' 'Ollama 不在线（127.0.0.1:11434）：请启动 Ollama（ollama serve 或桌面版）'
}

# ④ 三模型驻留（api/ps；未驻留只 WARN 不 FAIL）
try {
    $psInfo = Invoke-RestMethod -Uri 'http://127.0.0.1:11434/api/ps' -TimeoutSec 2
    $loaded = @($psInfo.models | ForEach-Object { $_.name })
    # 驻留判定：api/ps 的 models[].name 与模型名一致或互为前缀（如 qwen3:8b 驻留名可能带后缀）
    $notLoaded = @($models | Where-Object {
        $m = $_
        -not [bool]($loaded | Where-Object { $_ -eq $m -or $_.StartsWith($m) -or $m.StartsWith($_) })
    })
    if ($notLoaded.Count -eq 0) {
        Add-Check 'ollama-loaded' '三模型驻留内存' 'pass' ''
    } else {
        Add-Check 'ollama-loaded' '三模型驻留内存' 'warn' ("未驻留: " + ($notLoaded -join ', ') + "（首次推理会慢，建议先跑 start-demo.ps1 预热或 curl api/chat）")
    }
} catch {
    Add-Check 'ollama-loaded' '三模型驻留内存' 'fail' '无法访问 api/ps：确认 Ollama 在线'
}

# ⑤ 生产 Web 3100：HTTP 200 检查不依赖 dev server
try {
    $resp = Invoke-WebRequest -Uri 'http://127.0.0.1:3100' -UseBasicParsing -TimeoutSec 5
    if ($resp.StatusCode -eq 200) {
        Add-Check 'web' 'Web :3100 HTTP 200' 'pass' ''
    } else {
        Add-Check 'web' 'Web :3100 HTTP 200' 'fail' ("状态码 " + $resp.StatusCode + "，期望 200")
    }
} catch {
    Add-Check 'web' 'Web :3100 HTTP 200' 'fail' '3100 无响应：运行 start-demo.ps1（自动生产构建并携带本地认证环境启动 next start -p 3100）'
}

# ⑥ Worker 存活（pid 文件 + Get-Process；StartTime 不匹配只 WARN）
$workerPidFile = Join-Path $d 'worker.pid'
$workerChecked = $false
if (Test-Path $workerPidFile) {
    $wp = (Get-Content $workerPidFile -ErrorAction SilentlyContinue) -as [int]
    $wproc = if ($wp) { Get-Process -Id $wp -ErrorAction SilentlyContinue } else { $null }
    if ($wproc) {
        $tf = "$workerPidFile.time"
        if ((Test-Path $tf) -and ((Get-Content $tf -Raw).Trim() -ne $wproc.StartTime.ToString('o'))) {
            Add-Check 'worker' 'Worker 存活' 'warn' ("pid 文件 PID $wp 已被复用（StartTime 不匹配），状态不可信：建议 stop-demo 后重启")
        } else {
            Add-Check 'worker' 'Worker 存活' 'pass' "PID=$wp"
        }
        $workerChecked = $true
    }
}
if (-not $workerChecked) {
    Add-Check 'worker' 'Worker 存活' 'fail' 'worker.pid 不存在或进程已退出：运行 start-demo.ps1'
}

# ⑦（附）DB 可查 —— stdin 方式防引号剥离
try {
    $out = 'SELECT 1;' | & docker exec -i aichat-postgres psql -U aichat -d aichat -tA 2>$null
    if ($LASTEXITCODE -eq 0 -and ((@($out) -join '').Trim() -eq '1')) {
        Add-Check 'db' 'DB 可查 (SELECT 1)' 'pass' ''
    } else {
        Add-Check 'db' 'DB 可查 (SELECT 1)' 'fail' 'psql 查询失败：确认 aichat-postgres 容器 healthy 且账号/库名为 aichat'
    }
} catch {
    Add-Check 'db' 'DB 可查 (SELECT 1)' 'fail' 'docker exec 失败：确认 Docker 在线且容器在运行'
}

# ---------- 输出 ----------
if ($Json) {
    $payload = @{ checks = @($checks | ForEach-Object { @{ name = $_.name; state = $_.state; hint = $_.hint } }) } | ConvertTo-Json -Depth 3 -Compress
    Write-Output $payload
} else {
    Write-Host ''
    Write-Host ('{0,-16} {1,-26} {2,-6} {3}' -f 'CHECK', 'DESCRIPTION', 'STATE', 'HINT')
    Write-Host ('-' * 78)
    foreach ($c in $checks) {
        $label = switch ($c.state) { 'pass' { 'PASS' } 'warn' { 'WARN' } default { 'FAIL' } }
        Write-Host ('{0,-16} {1,-26} {2,-6} {3}' -f $c.name, $c.desc, $label, $c.hint)
    }
    Write-Host ('-' * 78)
}

$hasFail = [bool]($checks | Where-Object { $_.state -eq 'fail' })
if ($hasFail) { exit 1 } else { exit 0 }
