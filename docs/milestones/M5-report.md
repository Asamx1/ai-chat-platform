# M5 里程碑报告 — 可视化与回放

日期：2026-09-23 · 状态：**完成** · HEAD：见 git log

## 交付物（PLAN §12-M5 对照）

| 任务 | 实现 | 证据 |
|---|---|---|
| 运行时间线展示 | RunTimeline.tsx：事件流（seq 徽章/type 着色/provider.delta 缩略）、席位泳道时长条、成本条（usage-by-seat）、substituted 高亮、导出/刷新/折叠 | run-timeline.test |
| events JSON 分支 | `?format=json`（同 SSE 鉴权），供时间线与导出复用 | 同上 |
| usage 聚合 API | `/api/runs/[id]/usage`：UsageLog→ProviderCall→seat 聚合（calls/tokens/costMicros） | 同上 |
| 导出（含 configHash） | `/api/runs/[id]/export`：run+seats+events+usage+calls 全量 JSON 下载；configHash=sha256(configSnapshot) 前 16 hex | run-export.test |
| DB 冷启动回放 | Redis FLUSHALL 后纯 Postgres 回放 | replay-cold.test 2/2 |
| 会话页集成 | page.tsx 侧栏：SeatStatus + RunTimeline（默认折叠） | next build 绿 + ui-m5 冒烟 |

## 验收证据（PLAN M5 出口对照）

| 出口标准 | 结果 |
|---|---|
| 清空 Redis 并重启应用后仍可回放完整 run | ✅ replay-cold：Redis FLUSHALL → Postgres 327 事件全量回放，seq 严格递增无重复，终态唯一，回放零副作用，跨用户查无（events 路由本就直读 DB，Redis 仅作热缓存，架构上冷启动天然成立） |
| 导出包含 config hash 和 event count | ✅ export：configHash（sha256 前 16 hex）+ events 全量数组（count 即长度）+ seats/usage/calls |

## UI 冒烟（tests/ui-m5-smoke.cjs，4/4）

- 登录 → conversations API 活性 ✓
- events?format=json 未知 run 404 ✓（鉴权路径）
- export 未知 run 404 ✓
- 无预期外控制台错误 ✓ + 截图 ui-m5-home.png
- 附带修复：本地 HTTP 冒烟下 better-auth `__Secure-` cookie 不回传 → auth.ts 加 `AICHAT_LOCAL_SMOKE` 开关（生产 HTTPS 不受影响）

## 已知限制（转 M6）

1. RunTimeline 依赖页面传入 runId（从 CollabLauncher 发起后展示）；历史 run 浏览入口在 M6 实验平台一起做（runs 列表页）
2. provider.delta 在时间线默认采样显示（全量渲染 971 条会卡）
3. 导出为 JSON；CSV/离线包是 Optional

## 测试矩阵

web 5/5 套件（新增 run-export/run-timeline）+ worker 默认 5 文件 + 独立套件（debate-e2e/replay-cold）+ 全仓 10 套件 + 生产构建 11 路由 + UI 冒烟 4/4。
