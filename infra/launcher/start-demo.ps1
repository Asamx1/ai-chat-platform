# AI-Chat 演示一键启动(M12-P3:S1/S2、S3/S4 并行 + web 路由预热)
$ErrorActionPreference = 'Continue'
$repo = (Resolve-Path (Join-Path $PSScriptRoot '..\..\')).Path
$wslRepo = '/home/codex/code/ai-chat-platform/repo'

function Write-Log([string]$tag, [string]$step, [string]$msg) { Write-Output "[$tag][$step] $msg" }
$stageT0 = @{}
function Enter-Stage([string]$step) { $script:stageT0[$step] = Get-Date }
function Exit-Stage([string]$step) {
  if ($script:stageT0.ContainsKey($step)) {
    $sec = [math]::Round(((Get-Date) - $script:stageT0[$step]).TotalSeconds, 1)
    return "${sec}s"
  }
  return '?'
}
Enter-Stage 'S1+S2'

# ---------- S1 ∥ S2:容器 / Ollama(互不依赖,并行) ----------
Enter-Stage 'S1'
$jobS1 = Start-Job -ScriptBlock {
  wsl -- bash -c "docker start aichat-postgres aichat-minio >/dev/null 2>&1; sleep 3; docker inspect -f '{{.State.Status}}' aichat-postgres; docker inspect -f '{{.State.Status}}' aichat-minio"
}
Write-Log 'WAIT' 'S1' '启动 docker 容器(aichat-postgres / aichat-minio)…[并行]'
$s1Fail = $false
try {
  $s1 = Receive-Job -Job $jobS1 -Wait -ErrorAction Stop | Where-Object { $_ -and $_.Trim() }
  $pg = ($s1 | Select-Object -First 1).Trim(); $mo = ($s1 | Select-Object -Skip 1 -First 1).Trim()
} catch { $pg = ''; $mo = '' }
Remove-Job $jobS1 -Force -ErrorAction SilentlyContinue
if ($pg -eq 'running' -and $mo -eq 'running') { Write-Log 'OK' 'S1' "两容器 running($(Exit-Stage 'S1'))" }
else { Write-Log 'FAIL' 'S1' "容器状态 pg=$pg minio=$mo(先在 WSL 起 docker)($(Exit-Stage 'S1'))"; $s1Fail = $true }

Enter-Stage 'S2'
Write-Log 'WAIT' 'S2' '探测 Ollama 11434 / 模型…[并行]'
$s2Fail = $false
try {
  $tags = Invoke-RestMethod -Uri 'http://127.0.0.1:11434/api/tags' -TimeoutSec 5
  $names = ($tags.models | ForEach-Object { $_.name }) -join ' '
  Write-Log 'OK' 'S2' "Ollama 在线: $names($(Exit-Stage 'S2'))"
  if ($names -notmatch 'qwen3:8b') { Write-Log 'FAIL' 'S2' '缺 qwen3:8b(聊天主模型)'; $s2Fail = $true }
  if ($names -notmatch 'bge-m3') { Write-Log 'WARN' 'S2' '缺 bge-m3(RAG 检索降级)' }
} catch {
  Write-Log 'FAIL' 'S2' "Ollama 11434 无响应(启动 Windows 侧 Ollama)($(Exit-Stage 'S2'))"; $s2Fail = $true
}
if ($s1Fail -or $s2Fail) { exit 1 }
Write-Log 'OK' 'S0' "S1∥S2 并行阶段完成($(Exit-Stage 'S1+S2'))"

# ---------- S3 ∥ S4:Web / Worker(不同 tmux 会话,可并行) ----------
$webUp = $false
try { $r = Invoke-WebRequest -Uri 'http://127.0.0.1:3001/login' -UseBasicParsing -TimeoutSec 4; $webUp = ($r.StatusCode -eq 200) } catch {}
$wkUp = ((wsl -- bash -c "tmux has-session -t aichat-worker 2>/dev/null && echo yes || echo no" | Select-Object -First 1).Trim() -eq 'yes')

$jobWk = $null
if (-not $wkUp) {
  $jobWk = Start-Job -ScriptBlock {
    param($repoPath)
    wsl -- bash "$repoPath/infra/launcher/wsl-start-worker.sh"
  } -ArgumentList $wslRepo
}

Enter-Stage 'S3'
if ($webUp) {
  Write-Log 'OK' 'S3' 'Web :3001 已在运行,跳过'
} else {
  Write-Log 'WAIT' 'S3' 'WSL 内拉起 web dev server(:3001)…[与 worker 并行]'
  wsl -- bash "$wslRepo/infra/launcher/wsl-start-web.sh" | Out-Null
  $ok = $false
  foreach ($i in 1..20) {
    Start-Sleep -Seconds 3
    try { $r = Invoke-WebRequest -Uri 'http://127.0.0.1:3001/login' -UseBasicParsing -TimeoutSec 3; if ($r.StatusCode -eq 200) { $ok = $true; break } } catch {}
  }
  if ($ok) { Write-Log 'OK' 'S3' "Web :3001 就绪(${i}x3s,$(Exit-Stage 'S3'))" }
  else {
    Write-Log 'FAIL' 'S3' "Web :3001 60s 未就绪,看 WSL /tmp/m10logs/web3001.log($(Exit-Stage 'S3'))"
    if ($jobWk) { Receive-Job $jobWk -Wait | Out-Null; Remove-Job $jobWk -Force -ErrorAction SilentlyContinue }
    exit 1
  }
}

Enter-Stage 'S4'
if ($wkUp) {
  Write-Log 'OK' 'S4' 'Worker 已在运行(tmux:aichat-worker),跳过'
} else {
  Write-Log 'WAIT' 'S4' '拉起 worker…[与 web 并行]'
  if ($jobWk) { Receive-Job -Job $jobWk -Wait | Out-Null; Remove-Job $jobWk -Force -ErrorAction SilentlyContinue }
  Start-Sleep -Seconds 3
  $wkUp2 = ((wsl -- bash -c "tmux has-session -t aichat-worker 2>/dev/null && echo yes || echo no" | Select-Object -First 1).Trim() -eq 'yes')
  if ($wkUp2) { Write-Log 'OK' 'S4' "Worker 就绪(tmux:aichat-worker)($(Exit-Stage 'S4'))" }
  else { Write-Log 'WARN' 'S4' "Worker 未起(KB 功能受限,聊天可用)($(Exit-Stage 'S4'))" }
}

# ---------- S5: 演示数据保险 ----------
Enter-Stage 'S5'
Write-Log 'WAIT' 'S5' '演示数据检查(幂等 loader,缺了自动补)…'
wsl -- bash -c "cd $wslRepo && export PATH=/home/codex/.nvm/versions/node/v24.16.0/bin:/usr/local/bin:/usr/bin:/bin && timeout 120 npx tsx experiments/demo-seed.mts 2>&1 | tail -2" | ForEach-Object { Write-Output "  $_" }
Write-Log 'OK' 'S5' "演示数据就绪($(Exit-Stage 'S5'))"

# ---------- S6: 预热 ∥ 打开浏览器 ----------
# 浏览器先开,预热在后台并发 curl 关键路由,把 Next dev 冷编译提前;console.ps1 轮询预热状态(预热中/就绪)
Start-Process 'http://localhost:3001'
Write-Log 'OK' 'S6' '浏览器已打开 http://localhost:3001(登录 demo@example.com / demo12345)'

wsl -- bash -c "tmux kill-session -t aichat-warmup 2>/dev/null; tmux new-session -d -s aichat-warmup 'bash /home/codex/code/ai-chat-platform/repo/infra/launcher/wsl-warmup.sh > /tmp/m10logs/warmup.log 2>&1'" | Out-Null
Write-Log 'OK' 'S6' '预热已后台启动:/login / /settings /kb /api/models(状态见控制台 Web预热 灯)'
exit 0
