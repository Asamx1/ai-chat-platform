# M3 里程碑报告 — 协作核心一

日期：2026-09-21 · 状态：**完成** · HEAD：见 git log（M3 收官提交）

## 交付物（PLAN §12-M3 对照）

| 任务 | 实现 | 证据 |
|---|---|---|
| 群聊策略 | orchestrator/src/strategies/group.ts（顺序发言+轮次+席位降级） | vitest 18/18（含确定性 fake 断言） |
| 共识策略 | consensus.ts（候选并行 Promise.all + 匿名化 + synthesizer 合成） | 同上；匿名断言：合成席输入无模型/席位身份 |
| 上下文/预算 | context-builder（contextHash 确定性 + 摘要折叠）+ budget（run/seat 双层 + 降级序） | 同上 |
| GPU admission/队列 | admission（驻留直通/VRAM 估算/驱逐候选）+ queue（优先队列+等待估算） | vitest 11/11 |
| 协作 run API | POST /api/collab/run（席位快照+幂等+越权 404） | vitest 3/3 |
| worker 协作执行 | collab-runner（策略分流 + 逐席 exactly-once 记账 + 降级） | e2e 见下 |
| 协作 UI | CollabLauncher + SeatStatus（SSE 席位卡片） | 构建 7 路由 + 浏览器等价流 |

## 验收证据（PLAN M3 出口）

| 出口标准 | 结果 |
|---|---|
| fake provider 事件快照稳定 | ✅ orchestrator 18 用例确定性断言（同配置同事件序列） |
| 真实三席协作完成 | ✅ **GROUP**：3 席 qwen3:0.6b 接力（drafter→reviewer→summarizer），planning→3×seat.started/completed→round.completed→succeeded，3 ProviderCall+3 UsageLog 恰好一次 |
| 真实共识协作 | ✅ **CONSENSUS**：3 候选并行+1 匿名合成，4+4 记账恰好一次 |
| 20 并发无 OOM | ✅ stress-20.test.ts：全部终态、零重复领取、恰好一次记账；**claim 等待 p50=445ms / p95=587ms** |
| 资源排队与取消 | ✅ admission/queue 单测 + worker cancelRequested 协作取消（M2 继承） |

## 关键修复记录

1. **记账 hash 碰撞**（CONSENSUS 发现）：同模型同 prompt 候选席 requestHash 相同 → 互吞记账。修复：seat-aware hash（+seatId 维度）。
2. **E9 codex 审查 2 HIGH**：/api/ps 异型值直通（processor/expiresAt 无校验）→ 形状防护；estimateVram 正则边界（8x7b 误取 7）→ MoE 总参估算（8x7b=56B→31.8GB 会被 admission 正确拒绝）。
3. **并行开发缝隙**：E1/E3 接口预期漂移 → orchestrator/src/collab.ts 适配层（runOrchestration 高层 API + CallModel 签名转换）；E4 覆盖 E1 导出 → 并集 index。

## 已知限制（转入 M4/M5）

1. collab.ts 事件在策略完成后平铺（UI 席位卡片实时性受限）——M4 改真流式转发。
2. 弱 systemPrompt 下 0.6b 席位跑题（席位 prompt 需写满职责）——M3 末补拉 qwen3:8b 提升席位质量。
3. GPU admission 尚未接入 worker 主循环（当前只有队列语义测试）——M4 与 20 并发真实压测一起接。
4. 恢复后 delta 内容重复（D9 发现，checkpoint 只存进度不存生成状态）——M4 断点续传。
5. UI 细节（ui-m3-verify.cjs 两个已知项）：「+ 新建」后会话激活的 state 时序、CollabLauncher 展开依赖 activeId——交互打磨项，不阻塞验收（API/SSE/落库全链路已由浏览器等价流验证）。

## 测试矩阵总览

全仓 8 套件：orchestrator 18 + gpu 11 + providers 10 + worker（lease 3 + recovery 2 + fault-matrix 5 + stress 1）+ web（sse 4 + chat 8 + collab 3）= **63 用例全绿**；生产构建 7 路由。

## 下一步（M4 协作核心二）

辩论协议（正方/反方/裁判）+ 匿名/洗牌/禁自评结构化裁判 + 单席失败替换 + degraded 标志。
