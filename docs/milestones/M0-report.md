# M0 里程碑报告 — 风险原型

日期：2026-09-17 · 状态：**完成** · 仓库：E:\AI-Workstation\work\ai-chat-platform\repo（WSL 镜像 /home/codex/code/ai-chat-platform/repo，git 同步）

## 交付物与证据

| M0 任务 | 状态 | 证据 |
|---|---|---|
| monorepo + workspace + env 模板 + compose | ✅ | commit 55809aa；pnpm install --frozen-lockfile 通过（2026-09-17 复跑 530ms） |
| Prisma schema + 初始 migration | ✅ | 14 model + 5 enum；migration `20260917074240_init` 已应用；冒烟（建/查/删用户 + raw query）PASS |
| fake provider + 统一事件/usage 契约 | ✅ | packages/contracts（Zod：events/api/usage）+ packages/providers（ports + FakeProvider）；vitest 4/4 通过（21ms） |
| Ollama 基线实测 | ✅（部分） | 见下表；8B/14B 未测（本机无对应档位模型，qwen3:0.6b 与 qwen3.6:latest 覆盖小/大两端） |
| 实验 protocol v1 + 数据目录规范 | ✅ | docs/experiments/protocol-v1.md |

## 出口门禁（2026-09-17 实跑）

```
pnpm install --frozen-lockfile   → Done in 530ms
docker compose up -d             → postgres/redis/minio 全 healthy
pnpm exec prisma validate        → valid 🚀
pnpm exec vitest run             → Test Files 1 passed, Tests 4 passed
```

## Ollama 实测基线（RTX 5090 Laptop 24GB）

| 模型 | 规模 | 冷加载 | TTFT | 吞吐 | 显存增量 | 备注 |
|---|---|---|---|---|---|---|
| qwen3:0.6b (Q4_K_M) | 0.6B | 3.7s | 2.6s | 508.7 tok/s | +4.4GB | context 40960；快速通道可用 |
| qwen3.6:latest | 36B MoE | 18.1s | ~0s(热) | 59.9 tok/s | 94% CPU offload | context 262144；24GB 显存装不下，重 CPU 卸载 |

**结论（风险原型核心发现）**：36B 在本机 24GB 卡上 94% CPU 卸载、60 tok/s，做协作席位体验差；本地协作席位应以 ≤14B 量化模型为主（需补拉 qwen3:8b/14b 验证），36B 仅作裁判或对照。gemma3:4b 已损坏（乱码），不参与。

## 偏差与适配记录

1. **Prisma 7 破坏性变更适配**：datasource 不再写 url（移 prisma.config.ts `datasource.url`）；PrismaClient 必须显式传 `@prisma/adapter-pg` adapter；不自动读 .env（config 加 `import "dotenv/config"`）；monorepo 根装 prisma CLI 统一从根跑。
2. **minio 镜像**：docker.io 的 minio/minio 被本机网络拦截 → quay.io/minio/minio（digest 记录于 STATE.md）。
3. **Ollama 端点**：本机 ::1 上存在一个空模型库实例，`localhost` 会被解析到它 → 一律用 `127.0.0.1:11434`（.env.example 与 bench 脚本已固化）。
4. **Docker Desktop**：新装 WSL 后引擎起不来，根因是 `com.docker.service` 停止；启动服务（需管理员）+ `wsl --update` + 重启后恢复。容器随引擎自动拉起。
5. **仓库拓扑**：应用户要求 WSL 为主（/home/codex/code/ai-chat-platform），E 盘克隆供 AI-Workstation 派工；同步方向 = E 盘 push/合并 → WSL 侧 `git pull eclone main`（UNC push 不通）。

## 已知限制（不阻塞 M1）

- TTFT 对思考型模型测量有偏差（首个流 chunk 可能是空 thinking 帧），M5 指标模块需改用"首个非空 content"口径。
- packages/db 的 repositories 层、contracts 的完整 SSE 事件集按计划在 M1/M2 扩展。
- root 占位脚本（lint/typecheck/build）在 M1 接入真实工具链。

## 下一步（M1 单聊纵切，PLAN §12-M1）

认证（Better Auth）、会话/消息、Ollama + 一个云 Provider 适配器、runId 级 SSE 停止/重连、单聊页面。
