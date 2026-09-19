# M8 恢复：从 backup-*.sql.gz 恢复到目标库（默认恢复到 aichat_restore 验证库，不动生产）
# 用法: powershell -File infra/scripts/restore.ps1 -BackupFile <path.sql.gz> [-TargetDb aichat_restore]
param(
  [Parameter(Mandatory=$true)][string]$BackupFile,
  [string]$TargetDb = "aichat_restore"
)
$ErrorActionPreference = "Stop"

if (-not (Test-Path $BackupFile)) { throw "backup not found: $BackupFile" }

# 1) 建目标库（存在则重建——验证库语义）
$exists = (docker exec aichat-postgres psql -U aichat -d postgres -tAc "SELECT 1 FROM pg_database WHERE datname='$TargetDb'") -join ""
if ($exists.Trim() -eq "1") {
  docker exec aichat-postgres psql -U aichat -d postgres -c "DROP DATABASE $TargetDb WITH (FORCE);"
}
docker exec aichat-postgres psql -U aichat -d postgres -c "CREATE DATABASE $TargetDb OWNER aichat;"

# 2) 解压到临时明文 + docker cp + 容器内 psql -f（绕开宿主文本管道编码问题）
$tmpSql = Join-Path $env:TEMP "m8-restore-$TargetDb.sql"
$in = [System.IO.File]::OpenRead((Resolve-Path $BackupFile).Path)
$gz = New-Object System.IO.Compression.GZipStream($in, [System.IO.Compression.CompressionMode]::Decompress)
$out = [System.IO.File]::Create($tmpSql)
$gz.CopyTo($out); $gz.Dispose(); $out.Dispose(); $in.Dispose()
docker exec aichat-postgres rm -f /tmp/restore.sql
docker cp $tmpSql "aichat-postgres:/tmp/restore.sql"
if ($LASTEXITCODE -ne 0) { Remove-Item $tmpSql -Force; throw "docker cp failed" }
Remove-Item $tmpSql -Force
docker exec aichat-postgres psql -U aichat -d $TargetDb -v ON_ERROR_STOP=1 -q -f /tmp/restore.sql
if ($LASTEXITCODE -ne 0) { throw "psql restore failed: $LASTEXITCODE" }
docker exec aichat-postgres rm -f /tmp/restore.sql

# 3) 核验：表计数与 manifest 对照（取同目录 manifest）
$manifestPath = $BackupFile -replace '\.sql\.gz$', '.manifest.json'
$countsSql = @'
SELECT 'User='||(SELECT count(*) FROM "User")
  ||'|Conversation='||(SELECT count(*) FROM "Conversation")
  ||'|Message='||(SELECT count(*) FROM "Message")
  ||'|OrchestrationRun='||(SELECT count(*) FROM "OrchestrationRun")
  ||'|RunEvent='||(SELECT count(*) FROM "RunEvent")
  ||'|UsageLog='||(SELECT count(*) FROM "UsageLog");
'@
$countsSqlFile = Join-Path $env:TEMP "m8-counts.sql"
Set-Content -Path $countsSqlFile -Value $countsSql -Encoding ascii
$restored = Get-Content $countsSqlFile -Raw | docker exec -i aichat-postgres psql -U aichat -d $TargetDb -tA
Remove-Item $countsSqlFile -Force -ErrorAction SilentlyContinue
Write-Host "restored counts: $($restored.Trim())"
if (Test-Path $manifestPath) {
  $m = Get-Content $manifestPath -Raw | ConvertFrom-Json
  Write-Host "manifest counts: $($m.counts)"
  if ($m.counts.Trim() -ne $restored.Trim()) { throw "COUNT MISMATCH — restore verification FAILED" }
  Write-Host "RESTORE VERIFIED (counts match)"
} else {
  Write-Host "manifest not found beside backup — skip strict verify"
}

# 4) smoke：恢复库应答一条真实查询
$smokeSql = 'SELECT count(*) FROM "RunEvent" WHERE type=''run.succeeded'';'
$smokeSqlFile = Join-Path $env:TEMP "m8-smoke.sql"
Set-Content -Path $smokeSqlFile -Value $smokeSql -Encoding utf8
$smoke = Get-Content $smokeSqlFile -Raw | docker exec -i aichat-postgres psql -U aichat -d $TargetDb -tA
Remove-Item $smokeSqlFile -Force -ErrorAction SilentlyContinue
Write-Host "smoke run.succeeded events: $($smoke.Trim())"
Write-Host "RESTORE OK → db=$TargetDb (验证库，不覆盖生产)"
