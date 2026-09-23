# AI-Chat 演示自检(M11 版:探当前真实系统)
# 输出:逐行 [PASS]/[WARN]/[FAIL];-Json 时末行 JSON 供控制台轮询
param([switch]$Json)
$ErrorActionPreference = 'Continue'
$script:checks = @()
function Add-Check([string]$name, [string]$label, [string]$state, [string]$detail) {
  $script:checks += [pscustomobject]@{ name=$name; label=$label; state=$state; detail=$detail }
  if (-not $Json) {
    $tag = switch ($state) { 'pass' {'[PASS]'} 'warn' {'[WARN]'} default {'[FAIL]'} }
    $line = "$tag $label"
    if ($detail) { $line += " -- $detail" }
    Write-Output $line
  }
}

# ① 容器(WSL docker:postgres + minio;无 redis)
$containers = @('aichat-postgres','aichat-minio')
foreach ($c in $containers) {
  $st = (wsl -- bash -c "docker inspect -f '{{.State.Status}}' $c 2>/dev/null" | Select-Object -First 1).Trim()
  if ($st -eq 'running') { Add-Check $c.Replace('aichat-','') "$c 容器" 'pass' '' }
  else { Add-Check $c.Replace('aichat-','') "$c 容器" 'fail' "状态: $st" }
}

# ② Ollama(Windows 侧服务,11434)
try {
  $tags = Invoke-RestMethod -Uri 'http://127.0.0.1:11434/api/tags' -TimeoutSec 5
  $names = ($tags.models | ForEach-Object { $_.name }) -join ' '
  Add-Check 'ollama' 'Ollama 在线' 'pass' $names
  foreach ($m in @('qwen3:8b','bge-m3','qwen3:0.6b')) {
    if ($names -match [regex]::Escape($m)) { Add-Check "model-$m" "模型驻留 $m" 'pass' $names }
    else { Add-Check "model-$m" "模型驻留 $m" 'warn' "$m 未拉取" }
  }
} catch {
  Add-Check 'ollama' 'Ollama 在线' 'fail' '11434 无响应(启动 Windows 侧 Ollama)'
}

# ③ Web :3001
try {
  $resp = Invoke-WebRequest -Uri 'http://127.0.0.1:3001/login' -UseBasicParsing -TimeoutSec 6
  if ($resp.StatusCode -eq 200) { Add-Check 'web' 'Web :3001 /login 200' 'pass' '' }
  else { Add-Check 'web' 'Web :3001 /login' 'fail' ("状态码 " + $resp.StatusCode) }
} catch {
  Add-Check 'web' 'Web :3001' 'fail' '无响应:运行 start-demo.ps1 拉起 WSL dev server'
}

# ④ Worker(WSL 内 tsx worker 进程)
$wk = (wsl -- bash -c "pgrep -fc 'kb-worker|worker/src' 2>/dev/null || echo 0" | Select-Object -First 1).Trim()
if ($wk -match '^[1-9]') { Add-Check 'worker' 'Worker 进程' 'pass' "$wk 个进程" }
else { Add-Check 'worker' 'Worker 进程' 'warn' '未运行(KB 重建/重分块不可用;聊天不受影响)' }

if ($Json) { [pscustomobject]@{ checks = $script:checks } | ConvertTo-Json -Depth 4 -Compress }
