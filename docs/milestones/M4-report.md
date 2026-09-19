# M4 里程碑报告 — 协作核心二

日期：2026-09-22 · 状态：**完成** · HEAD：见 git log

## 交付物（PLAN §12-M4 对照）

| 任务 | 实现 | 证据 |
|---|---|---|
| 辩论协议 | strategies/debate.ts：pro/con 轮辩（默认 2 轮）、裁判匿名记录（[正方]/[反方] 无模型/席位身份）、judge-same-model 标注 | debate.test 7 用例（含 M4 集成计数） |
| 匿名+洗牌+禁自评 | judge.ts：Fisher-Yates（rng 注入可复现）、anonymize+orderMap 审计映射、selfJudged 标注 | judge.test 12 用例 |
| 结构化裁判 | judge-schema.ts：VerdictSchema 严格 JSON（winner/confidence/rationale/divergences）+ 一次修复重试 + 失败保留候选（verdict:null 不伪造） | 同上 |
| 管线接入 | collab.ts 动态 import DEBATE；contracts 枚举；collab API 席位 2-8 | collab-api.test 含 DEBATE 用例 |
| 单席失败替换 | collab-runner：-backup 后缀同 role 备席重试 + substituted 事件 | degrade-e2e 2/2 |
| degraded 标志 | OrchestrationRun.degraded/degradationReasons 落库 | degrade-e2e 断言 |

## 验收证据（PLAN M4 出口对照）

| 出口标准 | 结果 |
|---|---|
| 两轮辩论生成有效裁决 | ✅ 真实异构 e2e：qwen3:8b(正) vs qwen2.5:7b(反) + 8b 裁判；5 次席位调用、2 轮、degraded=0；**裁判结论落库**（“正方更有说服力…”） |
| 顺序映射可审计 | ✅ orderMap（label↔seatId/modelKey）在 judgePair 返回值中保存 |
| 裁判失败不伪造结论 | ✅ debate 策略裁判 throw 整体 FAILED；judgePair 双次 schema 失败返回 verdict:null |

## 真实异构辩论实录（debate-e2e.test.ts，独立套件）

- 席位：qwen3:8b（正方 104 tok/s）/ qwen2.5:7b（反方 119 tok/s）/ qwen3:8b（裁判，judge-same-model 标注）
- 议题：“远程办公是否应该成为公司默认选项？”
- 事件流：planning → round1(pro→con) → round2(pro→con) → judge → succeeded（约 32s）
- 记账：3 席位聚合恰好一次（tokens 跨轮累计）

## 工程质量修复（本里程碑）

1. collab.ts maxRounds 管道两处断裂（opts→ctx / snapshot→opts）
2. stress flaky 根治：aichat_test 独立测试库 + setupFiles 队列 drain（4/4×4 轮稳定）
3. 记账口径澄清：按席位聚合（每席一条 ProviderCall，tokens 累计），hash 含 seatId

## 已知限制（转 M5）

1. collab.ts 事件策略后平铺（非流式转发）——M5 可视化时改真流式
2. 裁判与辩手同模型时 selfJudged 已标注但未换模型（本地单卡限制；M6 实验用云模型做异构裁判消融）
3. debate-e2e 需独立跑（真实模型 32s，已从默认套件排除）

## 测试矩阵

全仓 10 套件（orchestrator 36 + gpu 11 + providers 10 + worker 5 文件 13 用例 + web 14）≈ **84 用例**；独立 e2e 套件：debate-e2e（真实模型）+ degrade-e2e；生产构建 7 路由。

## 下一步（M5 可视化与回放）

运行时间线 / token 成本展示 / DB 冷启动回放 / 配置导出。
