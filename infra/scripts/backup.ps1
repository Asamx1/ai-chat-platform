# M8 备份：PostgreSQL 逻辑全量 + 配置清单（MinIO 数据为可选 RAG 阶段，当前空卷）
# 用法: powershell -File infra/scripts/backup.ps1 [-OutDir <dir>]
# 产物: backup-<yyyyMMdd-HHmmss>.sql.gz + manifest.json（commit/时间/表计数）
param(
  [string]$OutDir = "E:\ai-chat-data\backups"
)
$ErrorActionPreference = "Stop"
function Take-First-Word { process { return ($_ -split '\s+')[0..3] -join ' ' } }

$ts = Get-Date -Format "yyyyMMdd-HHmmss"
New-Item -ItemType Directory -Force -Path $OutDir | Out-Null

$commit = git rev-parse --short HEAD 2>$null; if (-not $commit) { $commit = "unknown" }

# 1) pg_dump 逻辑备份（自定义库 aichat；容器名与 compose 一致）
$sql = Join-Path $OutDir "backup-$ts.sql"
# 二进制安全：容器内 dump 到 /tmp 再 docker cp 出来（PowerShell 管道重编码会损坏 COPY 数据）
docker exec aichat-postgres sh -c "pg_dump -U aichat -d aichat --no-owner --no-privileges > /tmp/backup.sql"
if ($LASTEXITCODE -ne 0) { throw "pg_dump failed" }
docker cp "aichat-postgres:/tmp/backup.sql" $sql
if ($LASTEXITCODE -ne 0) { throw "docker cp failed" }
docker exec aichat-postgres rm -f /tmp/backup.sql

# gzip 压缩（Windows 自带无 gzip，用 .NET GZipStream）
$src = [System.IO.File]::OpenRead($sql)
$dst = [System.IO.File]::Create("$sql.gz")
$gz = New-Object System.IO.Compression.GZipStream($dst, [System.IO.Compression.CompressionLevel]::Optimal)
$src.CopyTo($gz); $gz.Dispose(); $src.Dispose(); $dst.Dispose()
Remove-Item $sql

# 2) 表计数清单（恢复后核验用）
$countsSql = @'
SELECT 'User='||(SELECT count(*) FROM "User")
  ||'|Conversation='||(SELECT count(*) FROM "Conversation")
  ||'|Message='||(SELECT count(*) FROM "Message")
  ||'|OrchestrationRun='||(SELECT count(*) FROM "OrchestrationRun")
  ||'|RunEvent='||(SELECT count(*) FROM "RunEvent")
  ||'|UsageLog='||(SELECT count(*) FROM "UsageLog");
'@
$countsSqlFile = Join-Path $env:TEMP "m8-counts.sql"
Set-Content -Path $countsSqlFile -Value $countsSql -Encoding utf8
$counts = Get-Content $countsSqlFile -Raw | docker exec -i aichat-postgres psql -U aichat -d aichat -tA
Remove-Item $countsSqlFile -Force -ErrorAction SilentlyContinue

$manifest = [ordered]@{
  timestamp = $ts
  commit    = $commit
  file      = "backup-$ts.sql.gz"
  counts    = $counts.Trim()
  pgVersion = (docker exec aichat-postgres psql -U aichat -tAc "SELECT version();" | Take-First-Word)
}
$manifest | ConvertTo-Json | Out-File -Encoding utf8 (Join-Path $OutDir "backup-$ts.manifest.json")

Write-Host "BACKUP OK: backup-$ts.sql.gz"
Write-Host "counts: $($counts.Trim())"


