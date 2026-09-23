# AI-Chat 演示一键停止(M11 版)
param([switch]$IncludeContainers)
$ErrorActionPreference = 'Continue'
function Write-Log([string]$tag, [string]$msg) { Write-Output "[$tag] $msg" }

# 停 web / worker(tmux 会话 + 进程兜底;清理预热标记)
wsl -- bash -c "tmux kill-session -t aichat-web 2>/dev/null; tmux kill-session -t aichat-worker 2>/dev/null; pkill -f 'next dev|next-server' 2>/dev/null; pkill -f 'worker/src|kb-worker' 2>/dev/null; rm -f /tmp/m10logs/warmup.done; echo done" | Out-Null
Write-Log 'OK' 'web/worker 已停(tmux:aichat-web / aichat-worker)'

if ($IncludeContainers) {
  wsl -- bash -c "docker stop aichat-postgres aichat-minio 2>/dev/null" | Out-Null
  Write-Log 'OK' '容器已停(postgres / minio)'
} else {
  Write-Log 'OK' '容器保留(数据驻留,下次秒起)'
}
exit 0
