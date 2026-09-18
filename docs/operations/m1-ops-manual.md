结果（手册全文，markdown，直接输出）：

# M1 阶段开发环境运维手册（多模型协同对话平台）

环境：Win11 + Docker Desktop(WSL2)；pnpm monorepo（apps/web、apps/worker、packages/{db,contracts,providers,gpu-scheduler,orchestrator,observability,test-support}）；PostgreSQL17+pgvector / Redis7 / MinIO 容器（卷在 D:\ai-chat-data）；宿主 Ollama（127.0.0.1:11434，qwen3:0.6b / qwen3.6）；BetterAuth 邮箱密码；web 端口 3100（3000 被占）。

## 一、首次搭建
1. git clone <repo> 后 `pnpm install`
2. `cp .env.example .env`，按第五节核对；OLLAMA_BASE_URL 必须写 `http://127.0.0.1:11434`（禁 localhost：WSL/容器内 localhost 指向自身，连不到宿主）
3. `docker compose up -d postgres redis minio`，`docker compose ps` 确认 healthy
4. 数据库初始化（prisma 命令一律在仓库根目录执行，勿进 packages/db）：
   `pnpm prisma migrate deploy --schema packages/db/prisma/schema.prisma && pnpm prisma generate && pnpm seed`
5. 模型：`ollama pull qwen3:0.6b && ollama pull qwen3.6`，`curl http://127.0.0.1:11434/api/tags` 验证
6. `pnpm dev`，访问 http://localhost:3100，用邮箱密码注册首个账号

## 二、日常启动/停止清单
启动：①Docker Desktop（服务未起：管理员 PowerShell 执行 `net start com.docker.service`）→ ②确认 Ollama 在跑 → ③`docker compose up -d` → ④`pnpm dev`
停止：①Ctrl+C 停 dev → ②`docker compose stop`（勿用 `down -v`，会清卷）→ ③按需退出 Ollama / Docker Desktop
铁律：修改 packages/ 内任何文件后 dev server 不热更新，必须重启 `pnpm dev`。

## 三、常见故障排查表（症状→原因→命令）
- 模型调用 connection refused → OLLAMA_BASE_URL 用了 localhost → 改 127.0.0.1，重启 dev
- docker engine/pipe 报错 → com.docker.service 停止 → 管理员 `net start com.docker.service`
- minio 镜像拉取失败 → docker.io 拉不到 → 镜像改 `quay.io/minio/minio` 后 `docker compose pull minio`
- prisma 找不到 schema → 在 packages/db 内执行 → 回仓库根执行
- 改 contracts 后前端不生效 → packages 无热更 → 重启 pnpm dev；必要时 `pnpm -F <pkg> build`
- web 启动端口冲突 → 3000 被占 → 固定 `PORT=3100`
- 登录失败 → auth 配置错 → 核对 BETTER_AUTH_SECRET、BETTER_AUTH_URL=http://localhost:3100

## 四、数据备份与恢复
备份（建议每日、保留最近 7 份，落盘 D:\ai-chat-data\backups）：
`docker exec <pg容器> pg_dump -U postgres -Fc aichat > /mnt/d/ai-chat-data/backups/aichat_$(date +%F).dump`
MinIO 数据直接复制 D:\ai-chat-data\minio 目录；Redis 为缓存可不备。
恢复演练（每季度至少一次）：
1. `docker compose stop web worker` 停写
2. `docker exec <pg> dropdb -U postgres aichat && docker exec <pg> createdb -U postgres aichat`
3. `docker exec -i <pg> pg_restore -U postgres -d aichat --clean < 备份文件`
4. 验证向量扩展：`SELECT extname FROM pg_extension WHERE extname='vector';`
5. 起栈，登录 3100 抽查会话记录，确认后记录演练日期

## 五、环境变量说明表
- DATABASE_URL=postgresql://postgres:postgres@localhost:5432/aichat — PG17+pgvector
- REDIS_URL=redis://localhost:6379 — 队列/缓存
- S3_ENDPOINT=http://localhost:9000，S3_BUCKET=aichat，S3_ACCESS_KEY/S3_SECRET_KEY=minioadmin — MinIO
- OLLAMA_BASE_URL=http://127.0.0.1:11434 — 必须 127.0.0.1
- BETTER_AUTH_SECRET=`openssl rand -hex 32` 生成；BETTER_AUTH_URL=http://localhost:3100
- PORT=3100 — web 端口

## 六、端口清单
- 3100 web dev（宿主）；5432 PostgreSQL（容器映射）；6379 Redis（容器映射）
- 9000/9001 MinIO API/控制台；11434 Ollama（宿主 127.0.0.1）；3000 已被占用，禁用

changed files：无（按要求直接输出全文，未写文件）。

checks actually run：人工逐项核对——六个章节齐全；五个已知坑（Ollama 用 127.0.0.1、com.docker.service 需管理员启动、minio 用 quay.io、prisma 从仓库根跑、改 packages 后重启 dev）全部写入；环境事实（monorepo 结构、卷路径 D:\ai-chat-data、模型 qwen3:0.6b/qwen3.6、BetterAuth、端口 3100）均已体现；全文目测约 1300 字，在 1500 字以内（本会话无终端/计数工具，未做程序化字数统计）。未调用任何外部工具或检索。

remaining issues：
1. compose 服务名（postgres/redis/minio）、容器名、seed 脚本名（pnpm seed）、schema 路径为按常规约定的占位写法，合并前需对照仓库实际 docker-compose.yml 与 package.json 校准。
2. 备份目前只给了手动命令，Windows 计划任务（schtasks/Task Scheduler）自动化未展开，建议 M1 后续补一节。
3. pg_restore 的 `< 备份文件` 重定向在 Windows 宿主执行时需用 git-bash 或 `type 文件 | docker exec -i ...` 形式，手册中未细分两种 shell 差异。
