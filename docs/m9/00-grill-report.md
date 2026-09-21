# M9 需求审问报告(grill-me,2026-09-21)

方式:对抗式 24 问,用户全部按推荐答案确认。本轮目标=**RAG 质量增强 + 实验对比报告(毕设素材)为主,工程加固为体,演示顺手**。里程碑定名 **M9「RAG 质量增强」**,沿用 M0-M8 报告格式与 DoD 表。

## 决策表(全部已确认)

| # | 决策 |
|---|---|
| Q1 | 目标排序:b 实验对比报告为主、a 工程加固为体、c 演示顺手;不堆功能 |
| Q2 | 立 M9,产出 docs/milestones/M9-report.md |
| Q3 | 不做:云向量库/ES、OCR 与 PDF 内图片、ANN 索引重建、协作编排核心链路改动 |
| Q4 | 并行纪律:codex ≤3 并发、glm 2-3、kimi 拆片串行 |
| Q5 | 切割=策略注册表:结构感知(MD 标题层级)+ 递归字符分 + 固定窗(512/50 保留为对照组);Document.chunkStrategy 字段可插拔,默认结构感知 |
| Q6 | 父子块 small-to-big:Chunk.parentId(可空),检索子块去重后按父块合并,预算内裁剪 |
| Q7 | 块参数化:子块 256±128 自适应、父块 ≤1500;全部进策略配置不硬编码 |
| Q8 | 重切割 API:POST /api/kb/[id]/rechunk {strategy,size} → 文档重置 PENDING 走既有队列 |
| Q9 | 切割对比实验:复用 experiments/ 平台,3 策略 × QA 集(30-60 对,自动生成+人工筛),judge=qwen3:8b,Wilson 统计口径;**M9 皇冠交付物** |
| Q10 | 混合检索:PG tsvector+GIN 生成列,RRF(k=60) 融合,env 开关 |
| Q11 | Rerank:Ollama 无 /api/rerank(实测 404)→ LLM rerank(qwen3:0.6b/8b 对 top-20 出 JSON 排序),超时/解析失败回退纯向量序,env 可关,A/B 定默认 |
| Q12 | 多查询改写(0.6b,默认开、可关);HyDE 默认关 |
| Q13 | MMR λ=0.5 防同文档近似块刷屏,纯本地 |
| Q14 | Chunk.headingPath 存储(引用展示/实验归因用),不做 UI 过滤 |
| Q15 | 嵌入模型不换(bge-m3 1024 维保留) |
| Q16 | 嵌入性能:并发 2-4 + keep_alive 30m |
| Q17 | 不建 ANN;文档写明阈值(>1 万 chunks 或 P95>200ms 再引入) |
| Q18 | 测试:每特性单测 + 扩展 live-rag-smoke + 真实模型 e2e 独立套件(防 Ollama 互抢) |
| Q19 | 回滚=env 开关(hybrid/rerank/multiquery 默认 ON),新列可空增量迁移,无需 schema 回退 |
| Q20 | 检索质量回归门禁:5-10 固定 QA 对 live 门禁进 CI |
| Q21 | 团队=fullstack-9-agent 12 角色压缩 6 段:grill(已完)→PRD+架构+DBA 并行→开发(codex 主 85%/glm 15%)→安全+测试(glm)→wiki(kimi)→每段 Jev 门禁;运维段跳过 |
| Q22 | Jev 门禁 3 点位:PRD / 开发验收 / 测试报告(pass<0.4 打回,0.4-0.6 有条件放行,≥0.6 过) |
| Q23 | 预算:codex ≤8、glm ≤8、kimi 2-3 片、qwen 不限;两天节奏;超预算砍前端不砍测试 |
| Q24 | 前端只做:KB 块预览(chunk 列表+headingPath)+ 检索试验台(query→top-5+距离+融合来源);引用悬浮留 M10 |

## 任务板(~1h 粒度,单次运行 ≤2h,workstation timeout 900s 天然封顶)

| 片 | 任务 | 模型/kind | 产物 | 依赖 |
|---|---|---|---|---|
| S1 | PRD | kimi/plan | docs/m9/01-prd.md | 本报告 |
| S2 | 技术架构 | codex/code | docs/m9/02-arch.md | 本报告 |
| S3 | DBA 设计 | codex/code | docs/m9/03-db.md | 本报告 |
| S4 | 切割策略注册表+结构感知+父子块+单测 | glm/code | packages/rag/src/strategies/* | S2,S3 |
| S5 | 迁移+tsvector+store/retrieve 扩展+单测 | glm/code | prisma migration + rag/store,retrieve | S4 |
| S6 | 混合检索 RRF+MMR+单测 | glm/code | packages/rag/src/hybrid.ts | S5 |
| S7 | LLM rerank+多查询改写+降级+单测 | glm/code | packages/rag/src/rerank.ts,rewrite.ts | S6 |
| S8 | rechunk API+kb 块预览+检索试验台+测试 | glm/code 或 codex/code | apps/web/* | S6,S7 |
| S9 | 安全审计 | glm/review | docs/m9/09-audit.md | S4-S8 |
| S10 | 测试扩充+live 门禁+smoke 扩展 | glm/code | tests/* | S4-S8 |
| S11 | 切割对比实验跑批+分析 | 本地 qwen+脚本 | experiments/results/m9-* | S4-S8 |
| S12 | wiki 沉淀+M9-report | kimi | docs/milestones/M9-report.md | 全部 |
| G1-G3 | Jev 门禁 ×3 | jev/gate | docs/m9/gate-*.md | S1 / S8 / S10 |

预算核对:codex 计划 4 次(S2,S3,+S8 备用 1,+修复预留 1)≤8;glm 6 次(S4-S8,S9,S10 中 S8 可转 codex)≤8;kimi 2 片(S1,S12)。
