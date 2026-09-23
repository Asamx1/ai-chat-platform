# RAG 优化方案：切分策略 + LLM Wiki 编译层 + Ontology 实体图

> 日期：2026-09-23 · 状态：方案待评审（grill-me 两轮 10 问已对齐）
> 范围：`packages/rag`、`apps/worker`(kb-worker)、`apps/web`(kb API/playground)、`packages/db`(Prisma schema)

---

## 0. 现状盘点（已读代码确认）

检索链路已相当完整，**不缺零件，缺的是评测和知识编译层**：

| 层 | 现状 | 位置 |
|---|---|---|
| 切分 | `fixed` / `recursive` / `structure` 三策略 + parent-child（small2big），注册表可插拔，参数可校验 | `packages/rag/src/strategies/` |
| 嵌入 | Ollama `bge-m3`（1024 维），批量+并发池，3s 硬 deadline | `embed.ts` |
| 检索 | 查询改写 + 向量 + pg `tsv` 词法 RRF 混合 + MMR 去冗 + LLM rerank + small2big 父块扩展，全部可关、失败回退纯向量 | `retrieve.ts` |
| 存储 | pgvector + Prisma，`Chunk.kind = PARENT/CHILD/STANDALONE` | `packages/db` |
| 管线 | kb-worker 异步入库，`rechunk` API 已存在 | `apps/worker`, `apps/web/api/kb` |

**痛点（用户确认）：没有评测基线，不知道好坏。** 切分边界、表格、噪声都是猜测，不是证据。

---

## 1. 已对齐的决策（grill-me 结论）

1. **先建评测基线再动手**——20-50 条 golden Q&A，指标 HitRate@5 / MRR。
2. 评测问答对由 **DeepSeek 从现有文档自动生成候选，用户人工筛选**入库。
3. 切分改动：**新增 `semantic` 策略**（embedding 相似度找断点），其余暂不动。
4. LLM Wiki：**入库编译期**为每篇文档生成摘要页 + 实体页，**作为特殊 Document 入同一 KB 并 embed**，与原文 chunk 同库检索，`kind` 标记区分。
5. Ontology：**中等深度**——LLM 抽取实体+关系存 Postgres 表，检索时一跳图扩展 + 过滤；实体/关系类型**预定义 + 每 KB 可配置**。
6. 编译期 LLM 负载（评测生成/wiki 摘要/实体抽取）**全部走 DeepSeek API**，质量优先。
7. 已有文档：**后台批量重跑**全部 READY 文档（复用 rechunk 通路 + 新增编译步骤）。

---

## 2. 概念依据（调研摘要）

### 2.1 LLM Wiki（Karpathy, 2026-04 gist，5k+ stars）

- 核心论点：传统 RAG 每次查询**从零重新发现知识**（stateless）；wiki 模式在**入库时编译一次**（stateful），交叉引用、矛盾标注预先完成。
- 三层架构：raw（不可变源）/ wiki（LLM 维护的互链 markdown）/ schema（规范文件）。三操作：ingest / query / lint。
- 与 RAG 的关系（社区共识，particula.tech / kunalganglani.com）：**不是替代，是混合**——wiki 管稳定核心知识的"已编译"层，RAG 管新鲜/大规模数据。**本方案正是此混合形态**：wiki 页不落文件目录，而是作为特殊 Document 回灌向量库，参与统一检索。
- 风险警示（WiCER, arXiv 2605.07068）：**盲目编译会灾难性丢事实**（过度压缩 2-3×，53-60% 严重失败率）。对策：摘要页必须带 provenance（回指原文 chunk），且**原文 chunk 永远保留可检索**——wiki 层是增量而非替代。

### 2.2 Ontology-grounded RAG

- **OG-RAG**（Microsoft Research, 2025-04）：用领域 ontology 约束抽取，事实召回 +55%，回答正确率 +40%；且对 ontology 质量不敏感（dropout 50% 内指标稳定）——说明**轻量 schema 即可获益**，无需完美本体。
- **OMD-GraphRAG**（arXiv 2603.25152）：schema 引导抽取（预定义实体/关系模板注入 prompt + 事后类型校验）显著降噪；双通道融合（图遍历 + 语义检索）。
- **Deg-RAG**（arXiv 2510.14271）：LLM 抽的知识图有大量重复实体/错误关系，需**实体消歧 + 三元组反思过滤**——本方案一跳扩展之前必须做归一化（同名合并）。
- 完整 GraphRAG（社区检测+社区摘要）成本最高，**本期不做**，留扩展位。

---

## 3. 方案设计

### 阶段 0：评测基线（先于一切改动）

```
packages/rag/src/eval/
  golden-set.ts      # golden Q&A 读写（存 DB 表 RagEvalCase: question, expectedChunkIds/documentIds, kbId）
  runner.ts          # 对每题跑 retrieve(),计算 HitRate@5 / MRR@5,输出报告
  generate.ts        # DeepSeek 从每篇 READY 文档生成候选问答对 → 待筛选队列
```

- 新表 `RagEvalCase(id, kbId, question, expectedDocIds jsonb, source 'LLM_DRAFT'|'HUMAN_APPROVED', createdAt)`
- Web 端加评测页（或在 playground 加 tab）：候选问答列表 → 勾选批准 → 一键跑评测 → 报告（每策略对比）。
- **验收门槛**：后续任何切分/wiki/ontology 改动，必须 HitRate 不下降才算完成。

### 阶段 1：semantic 切分策略

新文件 `packages/rag/src/strategies/semantic.ts`，注册进现有 registry（`StrategyName` 加 `'semantic'`）：

1. 用 `structure` 的 `scanMarkdown` + `childUnits` 先切成**句子级单元**；
2. 对相邻单元算 embedding 余弦相似度（复用 `embed()`，批量一次调用）；
3. 相似度低于阈值（默认 0.75，可调 `semanticThreshold`）处断点为 chunk 边界；
4. 断点结果仍走 `packUnits` 约束 childMin/Target/Max + parent-child 打包——**输出结构与现有策略完全一致**，下游（small2big、kind、offset 校验）零改动。

`ChunkConfig` 增 `semanticThreshold: number`（0-1），`validateChunkConfig` 同步校验。

> 注意：semantic 策略在 chunk 阶段就要调 embed，kb-worker 的 ingest 时长会增加；嵌入失败回退 `structure` 策略并记录 warn，不阻塞入库。

### 阶段 2：Wiki 编译层（入库期）

kb-worker 在文档 READY 后追加**编译步骤**（DeepSeek API，异步、可重试、失败不阻塞文档状态）：

| 产物 | 内容 | 存储 |
|---|---|---|
| 文档摘要页 | 该文档的 300-500 字摘要 + 关键事实列表 + provenance（回指 chunk ordinal） | 特殊 `Document`（`kind='WIKI_SUMMARY'`，同 KB，embed 入库） |
| 实体页 | 抽取的每个实体一段：定义 + 相关事实 + `[[实体]]` 互链 + provenance | 特殊 `Document`（`kind='WIKI_ENTITY'`） |

- `Document` 表加 `kind` 列（`'SOURCE' | 'WIKI_SUMMARY' | 'WIKI_ENTITY'`，默认 SOURCE），`Chunk.kind` 不动。
- 检索侧：`retrieve()` 的 SQL 不加过滤（wiki 页与原文同场竞技，靠 RRF/rerank 自然排序）；**上下文组装时**若命中 wiki 页，其 provenance 指向的原文 chunk 一并取出（small2big 逻辑的兄弟路径）。
- 矛盾检测：编译新文档时，若新事实与既有实体页冲突，在实体页追加 `> ⚠️ 矛盾：[来源A] vs [来源B]`（对齐 wiki 模式的 lint 思想），不静默覆盖。

### 阶段 3：Ontology 实体图（一跳扩展）

新表（Prisma schema 迁移）：

```prisma
model Entity {
  id        String  @id @default(cuid())
  kbId      String
  name      String           // 归一化名
  type      String           // 来自 KB 的预定义类型集
  aliases   String[]         // 消歧：别名/大小写/简写
  mentions  EntityMention[]  // 实体 → chunk 的多对多
  @@unique([kbId, name, type])
}
model EntityMention {        // 实体在某 chunk 中被提及
  entityId  String
  chunkId   String
  @@id([entityId, chunkId])
}
model EntityRelation {       // 三元组:主体-关系-客体
  id        String @id @default(cuid())
  kbId      String
  subjectId String           // → Entity
  predicate String           // 来自 KB 预定义关系集
  objectId  String           // → Entity
  sourceChunkId String       // provenance
}
```

- **Schema 配置**：`KnowledgeBase` 加 `ontologyConfig jsonb`（`{entityTypes: [...], relationTypes: [...]}`，每 KB 可改，提供默认集：人物/组织/产品/技术/概念 + 属于/依赖/替代/导致/部分）。
- **抽取**（编译期，DeepSeek）：prompt 注入该 KB 的 schema 模板（对齐 OMD-GraphRAG 的 ontology-guided extraction），chunk 级抽取 → 归一化合并（同名/别名，对齐 Deg-RAG 消歧）→ 类型校验过滤 → 写表。
- **检索时一跳扩展**（在 `retrieve()` 的 hybrid 阶段并行执行，失败静默回退现有路径）：
  1. 从 query 中识别实体（词法匹配 Entity.name/aliases，不额外调 LLM，保 3s deadline）；
  2. 命中实体 → 查 `EntityRelation` 一跳邻居 → 邻居实体的 `EntityMention` chunk 作为第三路候选加入 RRF；
  3. 图路结果与向量路、词法路同等参与融合，不特权。

### 阶段 4：批量重跑与验收

- 复用 `rechunk` API 通路，加 `POST /api/kb/[id]/rebuild`（批量：该 KB 全部 READY 文档 → worker 排队 → 新切分 + wiki 编译 + 实体抽取）。
- 跑阶段 0 的评测对比：旧策略 vs semantic vs semantic+wiki+ontology，出报告。
- 成本护栏：DeepSeek 编译调用计入现有 `UsageLog`/`ProviderCall` 表（已有机制），report 里给单文档编译成本。

---

## 4. 实施顺序与验收标准

| # | 里程碑 | 验收 |
|---|---|---|
| M12-eval | 评测集表 + 生成器 + runner + UI 筛选 | 用户批准 ≥20 条 Q&A；baseline 报告产出 |
| M12a | semantic 策略 + 单元测试（对齐现有 strategies.test.ts 风格） | 测试绿；评测 HitRate ≥ baseline |
| M12b | wiki 编译层（摘要页+实体页入库检索） | 编译产物可见可检索；评测不降 |
| M12c | ontology 三表 + 抽取 + 一跳扩展 | 实体页有互链；含实体类问题 HitRate 提升 |
| M12d | 批量重跑 + 最终对比报告 | 全部 READY 文档重跑成功；报告归档 |

每项完成标准：测试绿 + `tsc` 0 错 + 评测报告对比（沿用 M9-M11 的验收纪律）。单文档编译成本、检索 P95 时延写入报告。

## 5. 明确不做（本期）

- 完整 GraphRAG（社区检测/社区摘要）
- wiki 落 markdown 文件目录 / Obsidian 集成（编译层在 DB 内，不落盘）
- 多跳推理、实体页的查询时 lint（矛盾检测只在编译期做）
- 编译期走本地 qwen（已定：DeepSeek API 质量优先）

## 6. 风险与回滚

| 风险 | 对策 |
|---|---|
| wiki 编译丢事实（WiCER 警示） | 原文 chunk 永远保留检索；摘要页必带 provenance；评测集兜底 |
| 实体抽取噪声（Deg-RAG 警示） | schema 约束 + 类型校验 + 别名归一化；图路只作第三路候选，失败静默回退 |
| 3s 检索 deadline 被图查询挤压 | 实体识别纯词法零 LLM；一跳查询走 `Promise.allSettled` 并行；超时自动放弃图路 |
| DeepSeek 编译成本失控 | worker 排队限流；UsageLog 记账；report 暴露单文档成本 |
| 回滚 | 每阶段独立开关（沿用 `RAG_*` 环境变量风格：`RAG_SEMANTIC`、`RAG_WIKI`、`RAG_GRAPH`，默认关，评测通过后再开） |

---

## 附：参考资料

- Karpathy LLM Wiki gist（2026-04）及社区解读：akitaonrails/ai-memory、particula.tech、kunalganglani.com
- WiCER: Wiki-memory Compile, Evaluate, Refine — arXiv:2605.07068
- OG-RAG: Ontology-Grounded RAG — Microsoft Research, 2025-04
- OMD-GraphRAG — arXiv:2603.25152
- Deg-RAG: Denoising Knowledge Graphs for RAG — arXiv:2510.14271
