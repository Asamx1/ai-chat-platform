# 00 Grill Report — 协作模式前端体验优化（collab-ux）

- 日期：2026-09-26｜审问官：GLM 5.3（grill-me 技能，2 轮，11+6 问全闭环）
- 范围：**纯前端**。packages/orchestrator 引擎、三策略、judge、schema、API 契约一律不动。

## 已核实事实
- 后端 collab.ts 已支持 GROUP/CONSENSUS/DEBATE 三模式；前端 CollabLauncher 将 DEBATE 置灰（注释"M4 交付"）——引擎已就绪，解锁为零后端改动。
- 现状痛点：模式/角色全英文裸标签；tokenBudget 裸数字输入；无席位预设；配置不记忆；运行侧栏（SeatStatus/RunTimeline）信息密度低；最终答案展示单薄。
- 涉事文件：apps/web/src/components/collab/（CollabLauncher 222 行 / SeatStatus 169 / OrchestrationProgress / run-progress / useRunProgress）+ runs/RunTimeline 205 行 + globals.css。

## 决议（用户确认）
1. **DEBATE 解锁**：前端启用，配一句中文模式说明。
2. **优化项 1–6 全做**：
   ① 席位预设模板（2席快速/3席标准/5席深度一键切换）
   ② 模式与角色中文化 + 悬浮说明（GROUP=各答各的/CONSENSUS=收敛共识/DEBATE=正反交锋；candidate/reviewer/summarizer/synthesizer 对应中文）
   ③ tokenBudget 档位化（省/标准/充足 + 自定义折叠）
   ④ 配置记忆（localStorage 回填上次席位组合）
   ⑤ 运行侧栏增强：轮次进度条、每席耗时徽标、live 输出预览
   ⑥ 最终答案展示优化：席位观点折叠对比 + 最终答案高亮
3. **前端执行岗**：先派 kimi（visual），简报写到逐文件改动清单粒度；2 轮挂即转 GLM 直做。
4. **视觉规范**：全站统一令牌（暗色+紫 #A855F7、settings-card 入场、紫聚焦环），零新依赖零逻辑改动。
5. **验收线**：tsc 严格 0 错 + web vitest 绿 + headless Edge 实测（面板开合/席位增删/预设切换/DEBATE 可选）+ 真发起一次 2 席 GROUP 跑通 SSE。
6. **流水线压缩版**：grill-report（本文）→ kimi 设计简报 → 开发单 1–2 张 → GLM 审计+测试合一 → Jev 门禁 → 用户验收。不走全 12 角色波次。

## 不做清单（本轮 OUT）
引擎/策略/judge/budget 任何改动；新协作模式（PIPELINE/REVIEW 等进 backlog）；schema/迁移；新依赖；移动端适配专项。
