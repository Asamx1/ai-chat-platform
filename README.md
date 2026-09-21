# ai-chat-platform

基于多模型协同编排的智能对话平台（毕业设计）。

- 权威方案：`../PLAN.md`（v1.3 executable baseline）
- 编排规程与进度：`../PLAYBOOK.md`、`../STATE.md`

## 技术栈基线

Next.js 16.3 · React 19 · TypeScript 5 strict · tRPC 11 · Prisma 7 · PostgreSQL 17 + pgvector · Redis 7 · MinIO · Ollama · Vitest · Playwright

## 目录

| 路径 | 职责 |
|---|---|
| `apps/web` | Next.js UI + API（M1 起） |
| `apps/worker` | durable orchestration worker（M2 起） |
| `packages/db` | Prisma schema、迁移、repositories |
| `packages/contracts` | Zod API 与事件 schema |
| `packages/orchestrator` | 引擎、策略、上下文、预算、裁判（纯逻辑，不依赖 Next/Prisma Client） |
| `packages/providers` | Provider 能力适配层（fake / ollama / openai-compatible） |
| `packages/gpu-scheduler` | GPU admission、队列、Ollama 遥测 |
| `packages/observability` | 日志、指标、trace |
| `packages/test-support` | fake provider、fixtures、virtual clock |
| `experiments/` | 实验配置、runner、统计与结果 |
| `infra/` | compose、Caddy、备份/恢复/健康脚本 |
| `docs/` | ADR、协议、实验、运维、里程碑报告 |

## 快速开始（空白环境完整路径）

前置：Windows 11 + Docker Desktop（WSL2 backend）+ Node.js 24 LTS + pnpm 10 + Ollama（含 qwen3:0.6b / qwen3:8b / qwen2.5:7b）+ D 盘 ≥100GB。

```powershell
# 1) 依赖
pnpm install --frozen-lockfile

# 2) 环境变量
Copy-Item .env.example .env
# 编辑 .env：DATABASE_URL/REDIS_URL/BETTER_AUTH_SECRET（必填）、SEED_ADMIN_EMAIL/PASSWORD（可选）

# 3) 基础设施（postgres 17 + redis 7 + minio；卷在 D:\ai-chat-data）
pnpm compose:up

# 4) 数据库迁移 + 种子（管理员账号）
pnpm --filter @aichat/db prisma migrate deploy
pnpm --filter @aichat/web seed

# 5) 构建 + 启动
pnpm --filter @aichat/web exec next build
pnpm --filter @aichat/web exec next start -p 3000   # Web/API
pnpm --filter @aichat/worker exec tsx src/main.ts    # durable worker（另开终端）

# 6) 验证
curl http://127.0.0.1:3000/                          # 登录页 200
node tests/smoke-db.mjs                               # DB 连通
node tests/m1-acceptance.mjs 10                       # SSE/隔离黄金路径
```

## Windows 演示启动器（生产模式，端口 3100）

完成上述依赖安装、数据库迁移与种子初始化后，可运行：

```powershell
powershell -File infra/launcher/start-demo.ps1
powershell -File infra/launcher/check-demo.ps1
powershell -File infra/launcher/stop-demo.ps1 -IncludeContainers
```

启动器加载根 `.env`，仅在进程环境覆盖 `BETTER_AUTH_URL=http://127.0.0.1:3100`、
`AICHAT_LOCAL_SMOKE=1`、`AICHAT_SECURE_COOKIES=0`，构建与运行均继承这些设置，不修改 `.env`。
当 `apps/web/.next/BUILD_ID` 不存在，或 Web、`packages/`、根环境/依赖/编译配置、启动脚本
比构建新时，在 `apps/web` 执行 `pnpm exec next build`；否则复用构建。
源码扫描跳过依赖、缓存与产物目录。删除文件或保留旧时间戳的变更后，可删除 `BUILD_ID` 强制重建。
构建失败会回滚本轮启动的服务；成功后执行 `pnpm exec next start -p 3100`，
worker 仍执行 `pnpm exec tsx src/main.ts`。停止脚本通过 PID 进程树及 3100 端口兜底停止服务，
检查脚本继续以 `http://127.0.0.1:3100` 返回 HTTP 200 判断 Web 就绪。

## 演示路径（答辩 5 分钟）

1. 登录 → 单聊（流式/停止/刷新续传）
2. 发起三席协作（CONSENSUS 或 DEBATE）→ SeatStatus 泳道 + RunTimeline 时间线
3. 停止运行 → 2 秒 cancelling；重启 worker → 60 秒内恢复
4. 运行导出（/api/runs/[id]/export，含 configHash）+ 回放（Redis 清空后 DB 冷启动仍可回放）
5. 实验表格（docs/experiments/m7-exp1-results.md、m7-exp2-results.md）

## 备份与恢复

```powershell
powershell -File infra/scripts/backup.ps1                       # → E:\ai-chat-data\backups\backup-*.sql.gz + manifest
powershell -File infra/scripts/restore.ps1 -BackupFile <path>   # → 恢复到 aichat_restore 验证库并核验计数
```

## 边界规则

1. `packages/orchestrator` 不依赖 Next.js、Prisma Client 或具体 Provider SDK。
2. PostgreSQL 是唯一 durable source of truth；Redis 可清空。
3. 密钥、模型文件、数据库数据、实验敏感原文永不提交。
4. 数据卷与模型只允许在 D 盘。
