# M13:RAG 优化方案实施(评测基线/版本基础/semantic/Wiki/实体图)

> 依据 docs/rag-wiki-ontology-plan-v2.md,11-agent 多模型协作流水线,2026-09-23~24
> 基线:369da62(方案入仓)← db2bbe5(M12);本里程碑终点 commit 见 git log

## 交付总览(阶段 A→F 全部闭环)

| 阶段 | 派工任务 | 执行器 | 产物 | 验收 |
|---|---|---|---|---|
| 0 审问 | — | GLM(对话) | docs/00-grill-report-rag.md(12问闭环,用户5决策) | 用户确认 |
| A 评测基线 | T-20260923-93e189c4 | codex/gpt-6-sol | packages/rag/src/eval/(types 8题型/metrics 4指标/runner 走生产检索/dataset-gen DeepSeek候选) | 252测试绿 |
| B 版本基础 | T-20260923-d00052d6 | codex/gpt-6-astra | SourceVersion/IndexGeneration/CompileJob+迁移回填+store generation化+激活回滚 | 262绿+迁移实测 |
| C semantic | T-20260923-680a9851 | codex/gpt-6-sol | planChunksAsync+semantic策略+worker降级观测 | 270绿 |
| D1 Wiki摘要 | T-20260924-93d1c86b | codex/gpt-6-sol | Document.kind+CompileOutbox+compile模块+RAG_WIKI开关+成本账本+预算暂停 | 277绿 |
| E1 实体事实层 | T-20260924-f97bcb46 | codex/gpt-6-astra | Entity/Alias/Mention/Relation/Evidence/DerivedFact+graph模块(抽取校验消歧/幂等/一跳) | 285绿 |
| D2/E2 实体页+图路 | T-20260924-7fbf27fd | codex/gpt-6-sol | entity-page渲染+RAG_GRAPH图路(双预算/独立权重/观测)+Wiki配额 | 291绿 |
| F 重建+消融 | T-20260924-735f009a | codex/gpt-6-sol | rebuild API+claimRebuild+ablation runner(5臂)+实跑脚本 | 293绿 |

## 门禁记录(jev noul)
A=0.60放行 / B=0.53有条件 / C=0.43有条件 / D1=0.46有条件 / E1=0.35※ / D2=0.35※
※noul 粒度粗(M9 已记录惯例),质量以编排方逐阶段实测(测试全绿+迁移实测+tsc)为准

## 关键实现决策
- DeepSeek 编译走 KB 用户 ProviderKey(AES-GCM 解密复用平台机制,D1)
- 默认全关:RAG_WIKI=false/RAG_GRAPH=false;消融后由用户显式开启(方案§7.3)
- 批量编译预算:单KB ¥5/批(CompileCostLedger 预检,超限暂停)
- 检索开关请求级注入(消融同进程不串臂)
- 图路:5实体/10关系/30chunk/300ms+剩余deadline 双预算,超时不阻塞主链路

## 遗留(下一步)
1. **消融实跑**(需要用户 ProviderKey 有 DeepSeek key + Ollama bge-m3 在线):`node scripts/rag-ablation.mjs`,产出 docs/eval/ablation-report-*.md 后由用户决定开启哪些能力
2. 评测集候选生成(D2 决策:GLM 初筛+用户抽检10题)
3. 主库(非空)迁移演练:阶段B回填在真实主库上的验证(先备份)
4. gpu-scheduler/observability 既有 tsc 错误(与本项目无关,未动)

## 成本
codex 7任务(6×gpt-6-sol+1×gpt-6-astra),glm 0 额度(对话编排),jev 6次判定(~$0.0006)
