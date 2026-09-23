# 00-grill-report — RAG Wiki/Ontology 修订版方案 grill 闭环

> 日期:2026-09-23 · 审问官:GLM-5.3(角色0) · 输入:`rag-wiki-ontology-plan-v2.md`(用户附件)
> 状态:12/12 问闭环,用户 5 项决策已确认,余 7 项按推荐默认执行

## 一、事实自查(执行前已核实,不问用户)

| # | 事实 | 核实方式 |
|---|---|---|
| F1 | 方案基线 `f1886d7` 在主仓任何分支都不存在;主仓实际 HEAD=`db2bbe5`(M12,已接入 DeepSeek provider 注册) | `git log --all` 全分支检索 |
| F2 | DeepSeek 凭据在平台内走用户 Web UI 存的 ProviderKey(按用户 AES-GCM 加密入库),`.env` 无 DeepSeek key;调用路径 `apps/web/src/lib/chat-service.ts`(fetch api.deepseek.com + 解密 + 计费) | schema.prisma + grep ProviderKey |
| F3 | `packages/rag` 现状与方案 §1 静态审阅一致:strategies/types.ts 同步接口、structure.ts 未导出 childUnits、embed.ts 批量并发池、retrieve.ts ~3s deadline | 目录扫描 + 方案 §1 对照 |
| F semantic/chat 链路已有 4 策略(fixed/recursive/parent-child/structure)+ registry + rewrite/rerank/hybrid(M9 已交付) | M9-report.md |
| F5 | 主库现有 KB 文档可做评测语料快照(M9 已跑过 60-QA 判别性实验,语料管线现成) | M9-report.md |
| F6 | 工作台四通道(kimi/glm/codex/qwen)+ jev 门禁全部可用 | workstation status(WSL 副本) |
| F7 | Document 必填 objectKey/mime/size 等;chunk 唯一约束 (documentId, ordinal);无 kind 字段;无 SourceVersion/IndexGeneration/CompileJob 模型 | schema.prisma |
| F8 | providerCalls 要求关联 OrchestrationRun(方案 §1 切中:编译计费需新账本) | schema.prisma line 209-232 |
| F9 | schema 中已有 Provider/ModelRegistry 模型,M12 seed 已注册 deepseek provider + 云端模型 | git log + seed grep |
| F/edge | WSL 曾出现 0x8007274c 连接失败,`wsl --shutdown` 后恢复;流水线期间 WSL 稳定性需留意(症状:UTF-16 乱码输出) | 本会话实测 |

## 二、用户决策(5 项,2026-09-23 clarify 确认)

| # | 问题 | 决策 |
|---|---≤---|---|
| D1 | DeepSeek 编译凭据 | **复用 KB 所属用户的 ProviderKey**(多租户正确,与现有权限边界一致) |
| D2 | 评测集人工审核方式 | **GLM 全量初筛 + 用户抽检~10题定夺**,其余按初筛结果标记 |
|2 | 评测固定语料 | **主库现有 KB 文档快照**,不足用户再补 |
| D4 | 批量编译成本上限 | **单 KB 每批次 ¥5、并发 2、重试上限 2** |
| D5 | 实施范围 | **A→F 全做**,按里程碑逐阶段验收+门禁 |

## 三、推荐默认(未问用户,按方案原文+工程惯例,异议随时改)

| # | 项 | 默认 | 依据 |
|---|---|---|---|
| P1 | 代码基线 | 主仓 `db2bbe5`(方案中 f1886d7 是旧 E: 副本基线,不存在于主仓) | F1 |
| P1' | 未跟踪文件 docs/rag-wiki-ontology-plan.md | 先 commit 入仓(方案来源文档) | 干净仓库要求 |
| P2 | Wiki 派生文档存储 | 复用现有 MinIO/S3 objectKey 体系,Document.kind=WIKI_* | 方案 §5.1 |
| P3 | semantic 起点阈值 | semanticThreshold=0.75 起步,开发集调参 | 方案 §4.2 |
| P4 | 图路保护上限 | 5 实体/10 关系/30 chunk/300ms | 方超市 §6.4 |
| P5 | generation 保留 | 最近 2 个历史 generation(回滚窗口) | 方案 §3.2 |
| P5' | 评测集规模 | 40 题(20-50 区间中值):8 类题型 × 5 | 方案 §2.1 |
| P6 | 评测分工 | agent 写工具,编排方(本轮 Hermes)本地跑评测(沙箱无 pnpm/Ollama) | workstation 惯例 |
| P7 | 默认开关 | RAG_WIKI=false、RAG_GRAPH=false、semantic 不动现有索引;消融定夺后由用户显式开启 | 方案 §7.3 |

## 四、闭环结论

✅ 12/12 问闭环,无遗留未知项。方案自洽性:方案 §0-§12 与主仓现状(F1-F9)无冲突项;唯一修订=基线改 `db2bbe5` + 方案文档入仓。放行进入阶段 A(评测基线)。

## 五、风险与边界

- **DeepSeek 花费**:阶段 A 候选生成 ~40题 × ~2k token ≈ ¥0.2-0.5;阶段 D/E 编译在 ¥5/批预算内,预算不足自动暂停(D4)。
- **周期**:A→F 七阶段,预计 3-5 个工作日(每阶段含派工→回收→本地实测→门禁→commit)。
- **失败保底**:每阶段可独立关闭(方案 §9),最坏情况止于 A+B 地基,已有产物不受损。
- **不做清单**:继承方案 §11(无社区检测、无多跳、无查询期 LLM 抽取、无自动冲突裁决、不默认开启)。
