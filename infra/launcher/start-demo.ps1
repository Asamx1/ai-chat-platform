# AI-Chat 演示一键启动(M11 版:WSL dev 模式,Web :3001)
$ErrorActionPreference = 'Continue'
$repo = (Resolve-Path (Join-Path $PSScriptRoot '..\..\')).Path
$wslRepo = '/home/codex/code/ai-chat-platform/repo'

function Write-Log([string]$tag, [string]$step, [string]$msg) { Write-Output "[$tag][$step] $msg" }

# ---------- S1: 容器 ----------
Write-Log 'WAIT' 'S1' '启动 docker 容器(aichat-postgres / aichat-minio)…'
wsl -- bash -c "docker start aichat-postgres aichat-minio 2>/dev/null; sleep 3; docker ps --format '{{.Names}}'" | Out-Null
$pg = (wsl -- bash -c "docker inspect -f '{{.State.Status}}' aichat-postgres 2>/dev/null" | Select-Object -First 1).Trim()
$mo = (wsl -- bash -c "docker inspect -f '{{.State.Status}}' aichat-minio 2>/dev/null" | Select-Object -First 1).Trim()
if ($pg -eq 'running' -and $mo -eq 'running') { Write-Log 'OK' 'S1' '两容器 running' }
else { Write-Log 'FAIL' 'S1' "容器状态 pg=$pg minio=$mo(先在 WSL 起 docker)"; exit 1 }

# ---------- S2: Ollama ----------
try {
  $tags = Invoke-RestMethod -Uri 'http://127.0.0.1:11434/api/tags' -TimeoutSec 5
  $names = ($tags.models | ForEach-Object { $_.name }) -join ' '
  Write-Log 'OK' 'S2' "Ollama 在线: $names"
  if ($names -notmatch 'qwen3:8b') { Write-Log 'FAIL' 'S2' '缺 qwen3:8b(聊天主模型)'; exit 1 }
  if ($names -notmatch 'bge-m3') { Write-Log 'WARN' 'S2' '缺 bge-m3(RAG 检索降级)' }
} catch {
  Write-Log 'FAIL' 'S2' 'Ollama 11434 无响应(启动 Windows 侧 Ollama)'; exit 1
}

# ---------- S3: Web(dev :3001) ----------
$webUp = $false
try { $r = Invoke-WebRequest -Uri 'http://127.0.0.1:3001/login' -UseBasicParsing -TimeoutSec 4; $webUp = ($r.StatusCode -eq 200) } catch {}
if ($webUp) {
  Write-Log 'OK' 'S3' 'Web :3001 已在运行,跳过'
} else {
  Write-Log 'WAIT' 'S3' 'WSL 内拉起 web dev server(:3001)…'
  wsl -- bash "$wslRepo/infra/launcher/wsl-start-web.sh" | Out-Null
  $ok = $false
  foreach ($i in 1..20) {
    Start-Sleep -Seconds 3
    try { $r = Invoke-WebRequest -Uri 'http://127.0.0.1:3001/login' -UseBasicParsing -TimeoutSec 3; if ($r.StatusCode -eq 200) { $ok = $true; break } } catch {}
  }
  if ($ok) { Write-Log 'OK' 'S3' "Web :3001 就绪(${i}x3s)" } else { Write-Log 'FAIL' 'S3' 'Web :3001 60s 未就绪,看 WSL /tmp/m10logs/web3001.log'; exit 1 }
}

# ---------- S4: Worker ----------
$wk = (wsl -- bash -c "pgrep -fc 'kb-worker|worker/src' 2>/dev/null || echo 0" | Select-Object -First 1).Trim()
if ($wk -match '^[1-9]') {
  Write-Log 'OK' 'S4' "Worker 已在运行($wk 个进程),跳过"
} else {
  Write-Log 'WAIT' 'S4' '拉起 worker…'
  wsl -- bash "$wslRepo/infra/launcher/wsl-start-worker.sh" | Out-Null
  Start-Sleep -Seconds 6
  $wk = (wsl -- bash -c "pgrep -fc 'kb-worker|worker/src' 2>/dev/null || echo 0" | Select-Object -First 1).Trim()
  if ($wk -match '^[1-9]') { Write-Log 'OK' 'S4' "Worker 就绪($wk)" } else { Write-Log 'WARN' 'S4' 'Worker 未起(KB 功能受限,聊天可用)' }
}

# ---------- S5: 演示数据保险 ----------
Write-Log 'WAIT' 'S5' '演示数据检查(幂等 loader,缺了自动补)…'
wsl -- bash -c "cd $wslRepo && export PATH=`$HOME/.nvm/versions/node/v24.16.0/bin:`$PATH && timeout 120 npx tsx experiments/demo-seed.mts 2>&1 | tail -2" | ForEach-Object { Write-Output "  $_" }
Write-Log 'OK' 'S5' '演示数据就绪'

# ---------- S6: 打开浏览器 ----------
Start-Process 'http://localhost:3001'
Write-Log 'OK' 'S6' '浏览器已打开 http://localhost:3001(登录 demo@example.com / demo12345)'
exit 0
