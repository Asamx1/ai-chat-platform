# M9 PRD:RAG 质量增强

里程碑:M9「RAG 质量增强」| 2026-09-21 | 上游:M9 需求审问报告(24 问全确认)| 终态产出:docs/milestones/M9-report.md(沿用 M0-M8 格式与 DoD 表)

## 1. 产品目标(排序已确认)

1. 实验对比报告(毕设素材):切割策略三方对比实验,可复现、带统计口径,为 M9 皇冠交付物。
2. 工程加固:检索全链路质量增强(切割→召回→融合→重排→去冗余),全部 env 可回滚。
3. 演示顺手:KB 块预览 + 检索试验台,让质量提升看得见。

不堆功能;超预算砍前端、不砍测试。

## 2. 用户故事

研究者(毕设作者)
- 对同一 KB 用 3 种切割策略跑同一 QA 集,得到带 Wilson 置信区间的胜率报告,结论可直接写进论文。
- 每块带 headingPath,坏 case 可归因到切割策略与文档章节。

演示者
- 在试验台输入 query 看到 top-5、距离与融合来源,现场证明混合检索生效。
- 即时开关 rerank/多查询改写做对比,各特性贡献可感知。

运维
- hybrid/rerank/multiquery 全部 env 开关;新列可空增量迁移;回滚=改环境变量,无 schema 回退。
- 文档写明 ANN 引入阈值,性能决策有据。

## 3. 功能清单与量化验收标准

F1 切割策略注册表
要点:structure-aware(MD 标题层级)/ recursive / fixed(512/50,对照组)三策略经统一接口可插拔;Document.chunkStrategy 落库,默认 structure-aware;子块 256±128 自适应、父块 ≤1500,全部进策略配置,零硬编码。
验收:①新增策略不改调用方代码;②默认策略=structure-aware;③三策略+参数边界的单测全绿。

F2 父子块 small-to-big
要点:Chunk.parentId 可空;检索命中子块,去重后按父块合并,预算内裁剪。
验收:①parentId 回填正确,顶层块为 null;②同父多命中仅返回 1 个父块;③合并输出 ≤ 配置预算;合并/裁剪/去重三分支单测覆盖。

F3 重切割 API
要点:POST /api/kb/[id]/rechunk {strategy,size};文档重置 PENDING 走既有队列,不另建管道。
验收:①非法 strategy 返回 400 且不清数据;②调用后由既有队列完成重切+重嵌入;③同参数重复调用幂等,无重复块。

F4 混合检索 RRF
要点:PG tsvector + GIN 生成列做关键词召回,与向量召回 RRF(k=60)融合;env 开关,默认 ON。
验收:①关键词-only 命中(专有名词/错误码)ON 时进入结果、OFF 时消失;②1 万 chunks 内 P95 延迟增量 ≤50ms;③OFF 时行为与 M8 完全一致。

F5 LLM rerank
要点:Ollama 无 /api/rerank(实测 404),用 qwen3:0.6b/8b 对 top-20 输出 JSON 排序;超时/解析失败回退纯向量序;env 可关;默认开/关由 A/B 实验定。
验收:①超时(阈值可配)与坏 JSON 均静默回退,不 5xx;②ON/OFF 结果可复现对比;③单测 mock 覆盖正常/超时/坏 JSON 三路径。

F6 多查询改写
要点:qwen3:0.6b 生成多路改写并行召回,默认开、env 可关;HyDE 实现但默认关。
验收:①每 query ≥2 路改写且原 query 必保留;②改写失败回退单查询;③关闭时零额外 LLM 调用。

F7 MMR 去冗余
要点:λ=0.5 可配,纯本地计算,防同文档近似块刷屏。
验收:①构造 5 个同文档近似块场景,MMR 开启后 top-5 中同文档块数较关闭时显著减少(单测断言);②λ 调整生效。

F8 Chunk.headingPath
要点:切割时记录标题路径入库,供引用展示与实验归因;本期不做 UI 过滤。
验收:①三级标题 MD 文档的块 headingPath 完整正确;②迁移可空增量,旧数据为 null 不报错。

F9 KB 块预览(前端)
要点:文档详情页 chunk 列表 + headingPath,分页。
验收:①1000 块文档分页加载,首屏 ≤1s(本地);②每块显示序号/策略/headingPath/字数。

F10 检索试验台(前端)
要点:query → top-5 + 距离 + 融合来源标记(向量/关键词/rerank)+ 特性开关实时对比。
验收:①结果显示来源与得分;②切换 hybrid/rerank 结果即时变化;③引用悬浮不做,留 M10。

F11 切割对比实验(皇冠交付物)
要点:复用 experiments/ 平台;3 策略 × QA 集(30-60 对,自动生成+人工筛);judge=qwen3:8b;Wilson 口径;结果存 experiments/results/m9-*。
验收:①报告含每策略胜率 + Wilson 95% CI + 判分明细;②一键复跑;③结论直接进 M9-report。

F12 质量回归门禁
要点:5-10 固定 QA 对 live 门禁进 CI;扩展 live-rag-smoke;真实模型 e2e 独立套件(防 Ollama 互抢)。
验收:①门禁失败阻断合并;②e2e 独立命令运行,不与单测并发。

## 4. 不做什么

- 云向量库 / ES;OCR 与 PDF 内图片;协作编排核心链路改动(Q3)
- ANN 索引:不建,文档写明阈值(>1 万 chunks 或 P95>200ms 再引入)(Q17)
- 嵌入模型更换:bge-m3 1024 维保留(Q15)
- 引用悬浮 UI、headingPath 的 UI 过滤:留 M10(Q14/Q24)

## 5. 工程约束

并行:codex ≤3 并发、glm 2-3、kimi 拆片串行。预算:codex ≤8、glm ≤8、kimi 2-3 片、qwen 不限;两天节奏。
流程:12 角色压缩 6 段:grill(完)→PRD+架构+DBA 并行→开发(codex 85%/glm 15%)→安全+测试(glm)→wiki(kimi);运维段跳过。
Jev 门禁 3 点位:PRD/开发验收/测试报告;pass<0.4 打回,0.4-0.6 有条件放行,≥0.6 通过。
回滚:三特性 env 默认 ON;parentId/headingPath/chunkStrategy 可空增量迁移,无需 schema 回退。
性能:嵌入并发 2-4 + keep_alive 30m。

## 6. DoD(对齐任务板 S1-S12 + G1-G3)

- [ ] S4-S8 合并,单测全绿
- [ ] S9 安全审计无高危遗留
- [ ] S10 live 门禁进 CI 且跑通
- [ ] S11 实验结果 + 分析报告落 experiments/results/m9-*
- [ ] S12 M9-report.md 按 M0-M8 格式产出
- [ ] G1-G3 门禁结论落 docs/m9/gate-*.md,均 ≥0.6 或有条件放行记录

---

*(产出:kimi-k3 @ T-20260921-2d989293,run 被 900s 超时截断但全文完整;由 Hermes 从 session 20260921_201658_5cc6ec 回收落盘)*
