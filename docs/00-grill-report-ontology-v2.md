# Grill Report — AI-chat × Ontology × LLM Wiki 方案 v2(P0 开工前对抗追问)

> 日期:2026-09-24。执行:Hermes(grill-me 技能,22 问)。用户答复:**全部按推荐执行**。
> 方案基线:`docs/ontology-wiki-plan-v2.md`(自 `Documents/Codex/2026-09-24/gen/outputs/AI-chat-Ontology-Wiki-方案-v2.md` 入仓)。
> 代码基线:WSL 主仓 HEAD `6573abd`(M13 收尾),工作区干净。
> 事实自查:M13 已有 `SourceVersion/IndexGeneration/CompileJob/CompileOutbox/CompileCostLedger/SummaryFact/Entity/EntityAlias/EntityMention/EntityRelation/RelationEvidence/DerivedFact/OntologyConfig` 14 张表;`retrieve.ts` 已有 RAG_WIKI/RAG_GRAPH 开关(默认 false);消融 runner 已实跑。方案 v2 的 Vault 文件层、断言状态机、schema YAML、发布批次、八页工作台、桌面化、OCR/字幕均为净新增。

## 决策清单(全部已锁定)

| # | 决策 | 结论 |
|---|---|---|
| Q1 | M13 资产继承 | M13 为底座增量演进,已有表加字段(assertionStatus/ruleVersion/revision),不推倒重建,消融基线有效 |
| Q2 | 里程碑编号 | P0=M14 … P4=M18,沿用 docs/milestones/Mx-report.md 惯例 |
| Q3 | 派工节奏 | ≤3 派工/日,9-agent 全波次仅用户点名时用;每日收官(全量回归→commit→同步) |
| Q4 | 各期时长 | P0 2-3 天 / P1 4-5 天 / P2 4-5 天 / P3 5-6 天 / P4 5-7 天;超期砍范围不砍验收(P3 OCR 可降级为「标记质量不足」分支) |
| Q5 | Vault 位置 | `D:\wiki-vault`,Windows NTFS 为权威;WSL 生成器经 /mnt/d 写入;Obsidian 直读 NTFS |
| Q6 | Vault 版本管理 | Vault 内独立 git 仓,发布批次自动 commit(message 带 revision+来源摘要);schema/ YAML 在 Vault 为权威,只读副本同步进主仓 packages/ontology/defaults/ |
| Q7 | 单/多 Vault | 首版单 Vault;vaultId 字段留余地,不做切换 UI |
| Q8 | 存量 KB | 双轨不迁移:存量 KB 走原 RAG 链路(开关维持 false),新 Vault 从零开始,不污染来源计数与消融基线 |
| Q9 | 首版本体范围 | 仅核心 7 类(Concept/Model/Method/Task/Metric/Dataset/Source)+ 9 种关系;AI 词表随 P1 语料按需走规则变更增补 |
| Q10 | 标准口径 | 借鉴 SHACL/SKOS/PROV-O 形状,自研 TS 校验,不宣称兼容任何 W3C 标准,不引入 RDF 引擎 |
| Q11 | 规则变更载体 | P0-P2 走文件 diff + 聊天确认;Web 确认页归 P4 |
| Q12 | 编译模型路由 | 断言抽取/来源摘要=DeepSeek(ProviderKey,CompileCostLedger 记账+每日成本上限,超限暂停);实体候选/别名归一/格式化=本地 qwen |
| Q13 | 嵌入检索 | 沿用 bge-m3(Ollama)+混合检索,不引入新嵌入模型 |
| Q14 | P1 PDF 边界 | 仅文字层 PDF;扫描件置「待 P3 OCR」状态,不静默丢 |
| Q15 | qwen 位置 | 严格问答主链全 DeepSeek;qwen 只做离线候选/归一,不进回答链 |
| Q16 | 问答形态 | 独立「知识问答」模式与自由聊天并列,绝不自动降级;现有聊天 RAG 挂载行为完全不动 |
| Q17 | 回答沉淀 | P2 手动确认沉淀;P3 依人工审核数据再评估自动沉淀 |
| Q18 | 人工修改检测 | P2 做启动时+发布前哈希扫描;P3 上文件监听 |
| Q19 | 桌面外壳 | P3 末打包 spike 二选一,倾向 Electron;允许 P3 末推翻 |
| Q20 | P4 依赖 | 安装器检测引导现有 Docker Desktop,不做内嵌单文件;启动器统一拉起 |
| Q21 | 11-agent 裁剪 | P0 无 Kimi;P1/P2 Codex 70%+GLM 30% 后端,GLM 全量 review+测试;Kimi 仅 P2 末八页 UI 原型进场;Jev gate 每期留档(阈值仅流程参考) |
| Q22 | 评测口径 | P0 评测样本 30 题起步,用户人工审核批准后冻结;冒烟报告声明无统计判别力 |

## 默认执行项(技术细节,异议随时改)

- 回收验收三件套:tsc -b + vitest 全量 +(涉库)真 PG 迁移实测;产物实核不信 status。
- 同 repo 派工串行(项目锁互斥);派工前 repo 必须干净。
- WSL 侧命令一律脚本文件落地再执行;wsl 调用走 bash -lc。

## 开放依赖(阻塞项)

- **P0 评测样本需要种子语料**:raw 仅用户添加。请用户向 `D:\wiki-vault\raw\articles|papers|transcripts\` 投放 5-10 份原始资料(AI 领域文章/论文/字幕均可),评测候选生成(DeepSeek)才能开工。
