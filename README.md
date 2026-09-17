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

## 快速开始

```powershell
pnpm install --frozen-lockfile
Copy-Item .env.example .env   # 填入本地值
pnpm compose:up               # postgres + redis + minio（卷在 D:\ai-chat-data）
pnpm --filter @aichat/db prisma migrate dev
```

## 边界规则

1. `packages/orchestrator` 不依赖 Next.js、Prisma Client 或具体 Provider SDK。
2. PostgreSQL 是唯一 durable source of truth；Redis 可清空。
3. 密钥、模型文件、数据库数据、实验敏感原文永不提交。
4. 数据卷与模型只允许在 D 盘。
