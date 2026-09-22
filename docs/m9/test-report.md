# M9 测试与验证报告(RAG 质量增强)

- 日期:2026-09-22 · 任务 ID:T-20260922-dac906fa(M9-S11)
- 范围:M9 全部新增/改动代码(切割策略注册表、父子块 small-to-big、混合检索 RRF+MMR、LLM rerank、多查询改写、重切割 API、KB 前端两页)
- 基线:M8 共 126 个测试;M9 收口后全仓 vitest 绿 **208 个**,新增 **82 个**
- 本报告仅文档产出,不涉及任何代码变更;所有命令均为复现指引,非本次执行记录

## 1. 测试清单(M9 新增 82 例)

| 套件 | 文件 | 用例数 | 覆盖内容 | 对应 PRD 需求 |
|---|---|---|---|---|
| 切割策略注册表 | `packages/rag/test/strategies.test.ts` | 33 | 结构感知(MD 标题层级)、递归字符分、固定窗 512/50 对照、父子块生成(parentId/headingPath/kind)、子块 256±128 自适应、父块 ≤1500 上限、策略注册表分发与未知策略报错 | Q5 / Q7 / Q14 |
| 检索管道 | `packages/rag/test/retrieve.test.ts`(S6+S7 扩展) | (含在 82 内) | RRF(k=60)融合、MMR λ=0.5、rerank 后 small-to-big 父块展开去重与预算裁剪、rerank 失败回退纯向量序、rewrite 失败回退原查询 | Q6 / Q10 / Q11 / Q13 |
| 数据层 | `packages/rag/test/store.test.ts` | (含在 82 内) | lease 守卫下的 chunk 批量写入、parentId 外键(ON DELETE SET NULL)、small-to-big 读取 | Q6 / Q19 |
| 重切割 API | `apps/web/test/rechunk-api.test.ts` | (含在 82 内) | POST /api/kb/[id]/rechunk 的鉴权/所有权校验、strategy 注册表白名单、size ∈ [64,4096] 整数校验、文档重置 PENDING 入队 | Q8 |
| LLM rerank | `packages/rag/test/rerank.test.ts` | (含在 82 内) | qwen3 对 top-20 出 JSON 排序、输出必须为候选编号的置换(防注入改变候选集)、超时/解析失败回退纯向量序 | Q11 |
| 多查询改写 | `packages/rag/test/rewrite.test.ts` | (含在 82 内) | 0.6b 改写输出 2-3 条字符串校验、env 开关(RAG_REWRITE)、失败回退原查询 | Q12 |

> 既有回归:apps/web 其余套件(auth/chat/rag-api/rag-chat 等)与 packages/rag 既有 pipeline/queue 套件全部保持绿,未出现破坏性改动(接口保留)。

## 2. 验证矩阵(需求 → 证据类型 → 结果)

| 需求 | 证据类型 | 结果 |
|---|---|---|
| Q5 切割策略注册表(三策略) | 单测(strategies.test.ts 33 例)+ 实验(见 Q9) | ✅ |
| Q6 父子块 small-to-big | 单测 + **PG 实测**(S6 端到端探针:子块命中后父块展开,返回 143 字符父块,确认生效) | ✅ |
| Q7 块参数化(256±128 / ≤1500) | 单测(参数进策略配置,无硬编码断言) | ✅ |
| Q8 重切割 API | 单测(rechunk-api.test.ts)+ tsc 严格模式 | ✅ |
| Q9 切割对比实验(皇冠交付物) | **实验**:第一轮 30 QA 三策略并列 93.3%;第二轮 60 QA(`experiments/runners/m9-chunk-compare.ts` + `experiments/datasets/m9-qa.json`,结果见 `docs/experiments/m9-chunk-compare.md`):structure 96.7%(Wilson 95% 下界 0.886)> fixed 95.0%(0.863)> recursive 93.3%(0.841);270 次 judge 调用 **零回退** | ✅ structure 胜出 |
| Q10 混合检索 RRF | 单测 + 迁移检查(`packages/db/prisma/migrations/20260921030000_m9_rag_quality/migration.sql`:tsvector 生成列 + GIN,经 psql 在 pgvector/pgvector:pg17 容器上验证) | ✅ |
| Q11 LLM rerank | 单测 + **live Ollama 探针**(3 轮稳定,~220ms) | ✅ |
| Q12 多查询改写 | 单测 + live Ollama 探针(~143ms) | ✅ |
| Q13 MMR λ=0.5 | 单测(纯本地,无外部依赖) | ✅ |
| Q18/Q20 回归与门禁 | vitest 全绿 208;dev-server 冒烟(auth 307/401 路径) | ✅ |
| 类型/构建 | `tsc --strict` 干净(packages/rag、apps/web) | ✅ |
| 数据库迁移 | `prisma migrate deploy` 对 pgvector:pg17 成功;psql 验证 vector 扩展、Chunk.parentId/headingPath/kind、tsv 生成列 + GIN 索引 | ✅ |

Hermes 验收会话的 live 回执(tsc / migrate / Ollama 探针 / 冒烟 / S6 PG 探针)均已在开发段逐任务回收并 commit,G2 复评(0.7)时内联验证。

## 3. 已知局限与残余风险

1. **rerank 排序被下游 distance 排序覆盖(实现细节)**:`packages/rag/src/retrieve.ts` 中检索 SQL 以 `ORDER BY distance,c.id` 返回,small-to-big 父块展开阶段(`retrieve.ts:154` 附近)按子块 distance 组织结果;LLM rerank 给出的顺序在部分下游路径会被 distance 重排稀释。当前实验臂(S9 纯向量)不受影响,hybrid 臂(S9b 之后)启用 rerank 时需复核最终顺序保真。
2. **引用来源入口链接缺失**:检索结果/前端块预览页(`apps/web/src/app/kb/[id]/chunks/page.tsx`)尚未提供指向原文位置的入口链接;引用悬浮 UI 与 headingPath 过滤已明确推迟至 M10(Q14/Q24)。
3. **提示注入残余(S10 审计,2 条 low)**:
   - `packages/rag/src/rerank.ts:7-11`:语料文本与查询一起送入本地 LLM,恶意文档可影响排序顺序;影响有界——输出被校验为候选编号的置换(`rerank.ts:12-14`),不能外泄数据、编造命中或改变候选集,只能在已授权的 top-20 内重排。
   - `packages/rag/src/rewrite.ts:6`:原始用户查询嵌入改写提示词,精心构造的查询可偏移改写;后果限于该用户自己的检索质量下降。
   - 审计结论:PASS,0 high/medium(见 `docs/m9/security-audit.md`)。
4. **门禁历史**:G1 0.48 有条件放行(条件:G2 ≥ 0.6);G2 首评 0.43 系输入贫乏(仅 claims 摘要,无证据),补内联证据后复评 **0.7 通过**。教训已记录:门禁输入必须内联可验证证据。
5. **实验口径**:S9 对照为纯向量余弦 top-5(无 RRF/MMR/rerank),策略胜出结论以该口径成立;hybrid 全开配置下的策略对比未在本轮范围内。

## 4. 复现命令

```bash
# 单测(全仓 208 绿)
pnpm install
pnpm test                # vitest run + @aichat/web test

# 类型检查(tsc 严格)
pnpm typecheck           # scripts/typecheck.mjs

# 数据库迁移(pgvector/pgvector:pg17,容器 aichat-postgres,宿主端口 5433)
# DATABASE_URL 需指向 5433(注意 .env 为 CRLF,bash source 不生效,用 python 解析或显式覆盖)
pnpm --filter @aichat/db exec prisma migrate deploy
psql "$DATABASE_URL" -c '\d+ "Chunk"'          # 验证 parentId/headingPath/kind/tsv+GIN
psql "$DATABASE_URL" -c 'select extname from pg_extension;'  # vector 扩展

# S6 端到端 PG 探针(small-to-big 父块展开)
# 通过检索试验台(见下)或 psql 对真实 KB 执行向量检索,确认返回父块文本

# 切割对比实验(S9,judge=qwen3:8b,本地 Ollama)
# 数据集:experiments/datasets/m9-qa.json;runner:experiments/runners/m9-chunk-compare.ts
# 结果:docs/experiments/m9-chunk-compare.md(+ m9-chunk-compare.json 逐 QA 原始行)

# dev-server 冒烟(auth 307/401)
pnpm dev:web              # 或 pnpm dev:all
node tests/smoke-login-page.cjs
node tests/live-rag-smoke.mjs   # 需要 Ollama 运行(bge-m3 / qwen3 系列)

# live Ollama 探针(rerank ~220ms / rewrite ~143ms,3 轮)
# 通过检索试验台(POST /api/kb/[id]/playground)触发,或直接调 packages/rag rerank/rewrite 模块

# env 开关(默认 ON,置 '0' 关闭):RAG_HYBRID / RAG_MMR / RAG_RERANK / RAG_REWRITE / RAG_SMALL / RAG_TIMEOUT
```

**一句话总结**:M9 以 82 个新增单测(共 208 绿)+ tsc/迁移/Ollama/冒烟 live 回执 + 60-QA Wilson 口径实验(structure 96.7%,下界 0.886 胜出)+ G2 0.7 与 S10 审计 PASS,完整覆盖 Q5-Q13 各项需求,残余风险仅 2 条有界 low 级提示注入备注与两项已排期的 M10 项。
