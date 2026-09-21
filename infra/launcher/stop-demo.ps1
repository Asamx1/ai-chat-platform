# B1 停止脚本 —— 按 orchestrator-spec（launcher-b1-engine）实现
# 用法: powershell -File stop-demo.ps1 [-IncludeContainers] [-Json] [-RepoRoot <path>]
# 退出码: 0 成功 / 1 失败
[CmdletBinding()]
param(
    [switch]$IncludeContainers,
    [switch]$Json,
    [string]$RepoRoot
)

$ErrorActionPreference = 'Continue'

$r = if ($RepoRoot) { (Resolve-Path $RepoRoot).Path } else { (Resolve-Path (Join-Path $PSScriptRoot '..\..\')).Path }
$d = Join-Path $env:TEMP 'aichat-demo'
$logPath = Join-Path $d 'launcher.log'
$exit = 0

function Write-Log {
    param([string]$Level, [string]$Step, [string]$Message)
    $ts = (Get-Date).ToString('yyyy-MM-dd HH:mm:ss')
    $line = "[$ts] [$Level] $Message"
    Write-Host $line
    if (Test-Path $d) {
        [IO.File]::AppendAllText($logPath, $line + [Environment]::NewLine, [Text.Encoding]::UTF8)
    }
    if ($Json) {
        $state = @{ 'OK' = 'ok'; 'WAIT' = 'wait'; 'FAIL' = 'fail' }[$Level]
        Write-Output ('{ "step": ' + (ConvertTo-Json $Step -Compress) + ', "state": ' + (ConvertTo-Json $state -Compress) + ', "message": ' + (ConvertTo-Json $Message -Compress) + ' }')
    }
}

# 停止单个 pid 文件对应进程：核对 .time（ProcessStartTime）防 PID 复用误杀
function Stop-ByPidFile {
    param([string]$Name)  # 'web' | 'worker'
    $pidFile = Join-Path $d "$Name.pid"
    $timeFile = "$pidFile.time"
    if (-not (Test-Path $pidFile)) {
        Write-Log 'OK' "STOP-$Name" "无 $Name.pid，跳过"
        return
    }
    $p = (Get-Content $pidFile -ErrorAction SilentlyContinue) -as [int]
    if (-not $p) {
        Remove-Item $pidFile, $timeFile -Force -ErrorAction SilentlyContinue
        Write-Log 'OK' "STOP-$Name" "pid 文件内容无效，已删除"
        return
    }
    $proc = Get-Process -Id $p -ErrorAction SilentlyContinue
    if (-not $proc) {
        Remove-Item $pidFile, $timeFile -Force -ErrorAction SilentlyContinue
        Write-Log 'OK' "STOP-$Name" "进程 $p 已不在，清理 pid 文件"
        return
    }
    # 防误杀：核对 ProcessStartTime 与 .time 文件一致，不一致只告警不杀
    if ((Test-Path $timeFile) -and ((Get-Content $timeFile -Raw).Trim() -ne $proc.StartTime.ToString('o'))) {
        Write-Log 'WAIT' "STOP-$Name" "PID $p 已被复用（StartTime 不匹配），跳过杀进程，仅删 pid 文件"
        Remove-Item $pidFile, $timeFile -Force -ErrorAction SilentlyContinue
        return
    }
    # cmd→pnpm→next start/tsx 的 node 进程树：taskkill /T /F + Stop-Process
    taskkill /PID $p /T /F 2>$null | Out-Null
    try { Stop-Process -Id $p -Force -ErrorAction SilentlyContinue } catch {}
    Remove-Item $pidFile, $timeFile -Force -ErrorAction SilentlyContinue
    Write-Log 'OK' "STOP-$Name" "已停止 $Name（PID=$p）"
}

try {
    if (-not (Test-Path $d)) {
        New-Item -ItemType Directory -Path $d -Force | Out-Null
    }

    # 顺序：worker → web
    Stop-ByPidFile 'worker'
    Stop-ByPidFile 'web'

    # 端口兜底：3100 仍有监听则强杀
    $listeners = Get-NetTCPConnection -LocalPort 3100 -State Listen -ErrorAction SilentlyContinue
    foreach ($l in $listeners) {
        Write-Log 'WAIT' 'STOP-web' "端口 3100 仍被 PID $($l.OwningProcess) 监听，强制清理"
        taskkill /PID $l.OwningProcess /T /F 2>$null | Out-Null
    }

    # 可选：容器 stop（不 down，保数据卷）
    if ($IncludeContainers) {
        $composeFile = Join-Path $r 'infra\compose.yaml'
        & docker compose -f $composeFile --env-file (Join-Path $r '.env') stop 2>&1 | ForEach-Object { Write-Host "  $_" }
        if ($LASTEXITCODE -ne 0) { Write-Log 'FAIL' 'STOP-containers' 'docker compose stop 失败'; $exit = 1 }
        else { Write-Log 'OK' 'STOP-containers' '容器已停止（数据卷保留）' }
    }

    Write-Log 'OK' 'done' '停止完成'
    if ($Json) { Write-Output '{ "step": "done", "state": "ok" }' }
    exit $exit
}
catch {
    Write-Log 'FAIL' 'stop' "异常: $($_.Exception.Message)"
    exit 1
}
