# ai-chat-platform

**English** · 中文版见下文

A multi-model orchestration chat platform: multiple LLMs (local Ollama + cloud OpenAI-compatible providers) collaborate in single-chat or multi-seat modes (CONSENSUS / DEBATE), with durable runs, streaming, replay, RAG (pgvector hybrid retrieval), GPU admission scheduling, and a full experiment/eval harness.

Stack: Next.js 16 · React 19 · TypeScript (strict) · tRPC 11 · Prisma 7 · PostgreSQL 17 + pgvector · Redis 7 · MinIO · Ollama · Vitest · Playwright.

---

# ai-chat-platform（中文）

基于多模型协同编排的智能对话平台。

## ✨ 特性

- **多席协作**：一次对话中多个模型各持一席，支持 CONSENSUS（共识）/ DEBATE（辩论）两种协作策略，SeatStatus 泳道 + RunTimeline 时间线实时展示
- **本地 + 云端混合模型**：Provider 适配层统一接入 fake / Ollama / OpenAI 兼容云端 API；GPU admission 排队与 Ollama 遥测
- **durable 运行**：PostgreSQL 为唯一事实源，Redis 仅作热路径；运行可停止（2s cancelling）、可恢复（重启 worker 60s 内续跑）、可导出回放（含 configHash，Redis 清空后冷启动仍可回放）
- **RAG**：pgvector 混合检索（词法 ts_rank + 向量余弦 → RRF → MMR），结构感知父子分块
- **实验与评测**：实验配置/runner/统计一体化，含严格 QA 报告与检索质量评估（hit@5 等指标）

## 技术栈基线

Next.js 16.3 · React 19 · TypeScript 5 strict · tRPC 11 · Prisma 7 · PostgreSQL 17 + pgvector · Redis 7 · MinIO · Ollama · Vitest · Playwright

## 目录

| 路径 | 职责 |
|---|---|
| `apps/web` | Next.js UI + API |
| `apps/worker` | durable orchestration worker |
| `apps/desktop` | Electron 桌面端壳（spike） |
| `packages/db` | Prisma schema、迁移、repositories |
| `packages/contracts` | Zod API 与事件 schema |
| `packages/orchestrator` | 引擎、策略、上下文、预算、裁判（纯逻辑，不依赖 Next/Prisma Client） |
| `packages/providers` | Provider 能力适配层（fake / ollama / openai-compatible） |
| `packages/gpu-scheduler` | GPU admission、队列、Ollama 遥测 |
| `packages/rag` | 混合检索、分块、重排 |
| `packages/observability` | 日志、指标、trace |
| `packages/test-support` | fake provider、fixtures、virtual clock |
| `experiments/` | 实验配置、runner、统计与结果 |
| `infra/` | compose、Caddy、备份/恢复/健康脚本 |
| `docs/` | ADR、协议、实验、运维、里程碑报告 |

## 快速开始

前置：Windows 11 + Docker Desktop（WSL2 backend）+ Node.js 24 LTS + pnpm 10 + Ollama（含 qwen3:0.6b / qwen3:8b / qwen2.5:7b）。

```bash
# 1) 依赖
pnpm install --frozen-lockfile

# 2) 环境变量
cp .env.example .env
# 编辑 .env：DATABASE_URL/REDIS_URL/BETTER_AUTH_SECRET（必填）、SEED_ADMIN_EMAIL/PASSWORD（可选）

# 3) 基础设施（postgres 17 + redis 7 + minio）
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

种子账号：`demo@example.com` / `demo12345`（演示用）。

## 演示路径

1. 登录 → 单聊（流式/停止/刷新续传）
2. 发起三席协作（CONSENSUS 或 DEBATE）→ SeatStatus 泳道 + RunTimeline 时间线
3. 停止运行 → 2 秒 cancelling；重启 worker → 60 秒内恢复
4. 运行导出（/api/runs/[id]/export，含 configHash）+ 回放（Redis 清空后 DB 冷启动仍可回放）

<!-- TODO: 界面截图 -->

## 备份与恢复

```powershell
powershell -File infra/scripts/backup.ps1                       # -> 备份目录 backup-*.sql.gz + manifest
powershell -File infra/scripts/restore.ps1 -BackupFile <path>   # -> 恢复到 aichat_restore 验证库并核验计数
```

## 架构边界

1. `packages/orchestrator` 不依赖 Next.js、Prisma Client 或具体 Provider SDK。
2. PostgreSQL 是唯一 durable source of truth；Redis 可清空。
3. 密钥、模型文件、数据库数据、实验敏感原文永不提交。

## License

MIT
