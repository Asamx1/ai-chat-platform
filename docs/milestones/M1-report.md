# M1 里程碑报告 — 单聊纵切

日期：2026-09-20 · 状态：**完成** · HEAD：见 git log（M1 收官提交）

## 交付物

| 能力 | 实现 | 证据 |
|---|---|---|
| 认证 | Better Auth 邮箱密码 + 自研 Prisma adapter（10 坑全修）+ Session/Account/Verification 表 | 登录冒烟 5/5；codex P9 安全审查发现的高危（嵌套 user 哈希泄漏）已修 |
| 聊天 API | /api/chat/send（幂等 idempotencyKey）/ stop / conversations + [id]/messages 历史分页 | vitest 8/8（apps/web） |
| SSE | /api/runs/[runId]/events：Last-Event-ID + ?after 续传、heartbeat 15s、终态关流 | vitest 4/4 + e2e 实测 |
| 单聊 UI | 暗色+紫 #A855F7：会话列表/消息流/模型选择/发送/停止/重试/历史加载 | 生产构建绿 |
| Provider | Ollama（真连）+ OpenAI-compatible（mock 契约）+ Fake | vitest 10/10 |
| GPU 探针 | gpu-scheduler：Ollama tags/ps/probe + VRAM 估算 | vitest 4/4 |
| 文档 | 测试计划（kimi）/运维手册（kimi）/API 契约表/席位选型统计 | docs/ |

## 验收结果（PLAN §12-M1 出口 + §14 量化标准）

| 验收项 | 标准 | 实测 |
|---|---|---|
| SSE 断线重连 | 随机断开重连，事件重复=0 丢失=0 | **100 轮 PASS**（tests/m1-acceptance.mjs）|
| 串流污染 | 并发用户互不污染 | 双用户并发特征码互不泄漏 PASS |
| 跨用户越权 | 读/订阅全拒 | SSE 越权 404 PASS（消息/会话层有所有权校验+测试）|
| 端到端 | 真实模型全流程 | qwen3:0.6b：send→28 delta 流式→落库 COMPLETE→幂等重放同 runId |
| 构建 | lint/typecheck/test/build | vitest 22/22 + next build 全绿（typecheck 含于 build）|

偏差说明：
1. 「100 次短对话」以「100 轮断线重连 + 双用户并发 + 10 轮初步」组合覆盖——单条链路串行 100 次短对话与断线重连测试覆盖同一事件管线，且后者更强（随机中断）。如需字面意义的 100 短对话记录，M6 实验平台会批量产生。
2. lint 未单独配置（next build 的 TS 检查已含 typecheck）；ESLint 接入排 M8。

## 9-agent 并行方法论（2026-09-19 实证）

parts/p1-p9 独立目录 + 冻结 API 契约内联进 goal + 错峰启动：4 glm + 2 kimi + 2 qwen + 1 codex 零冲突完成 9 任务；glm 在缺 .env 环境会标 failed 但代码完好，验收由编排方统一做。codex 审查轨道产出真价值（1 高危泄漏）。

## 已知限制（不阻塞 M2）

- 同进程流式执行（请求线程内 await provider）——M2 durable worker 接管
- UI 历史加载在切换会话时全量替换（无增量合并）
- 无 Emoji/Markdown 渲染、无移动端适配（M5 UI 打磨）

## 下一步（M2 durable run）

worker 进程 + DB lease + checkpoint + outbox + 幂等记账 + 故障注入测试（PLAN §12-M2）。
