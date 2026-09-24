# M14(P0)收官报告 — Ontology × Wiki 方案 v2 启动期

> 日期:2026-09-24(单日完成)。状态:**P0 全部交付**。主仓 HEAD `7fe774f`。

## 交付物对照(方案 §10 P0 验收:相同问题的类型、证据、拒答规则可明确判定)

| 要求 | 交付 | 证据 |
|---|---|---|
| 核心本体 | `packages/ontology`(7 类 9+1 关系;constraints;2 条白名单推理规则) | commit `8d722ce`;tsc 0 错 |
| 页面规范/权限/来源策略 | Vault `D:\wiki-vault`(CLAUDE.md v1.0.0=scheme §11 落地;schema 1.0.0 权威副本;raw 只读策略) | vault commits `5652e89`/`d8f5afa` |
| 知识引用契约 | `packages/contracts` WikiPointer/SourceLocator 四型/encode-decode/旧 RAG 映射 | commit `32d5e7d` |
| 评测样本 | `docs/eval/ontology-eval-draft.json`:8 来源 59 题,六类型覆盖(fact13/synonym8/single11/version9/unanswerable9/out_of_scope9),41 可答/18 拒答,52 锚点逐字+sha256 校验全过;DeepSeek 真跑,0 失败 | commits `6ebeadb`+`7fe774f`(冻结,用户批准) |

## 验收口径

- vitest 全量 335 测试绿(35→36→37 文件递增)。
- typecheck:与干净 worktree 基线 `32d5e7d` 逐条比对,本期 diff 零新增错误(既有 db generated/gpu-scheduler/store.ts TS2742/TS2353 为 M13 遗留,另案处理)。
- 评测统计无统计判别力声明沿用 M13 惯例。

## 执行记录

- Grill 22 问闭环(`docs/00-grill-report-ontology-v2.md`),全部按推荐锁定。
- 3 派工/日限额内:codex 三连(A/B/C),Hermes 编排+回收+验收+真跑。
- 排障:WSL broker 重建、workstation policy/checks 预声明、tsx 运行时、DB 端口映射。
- 种子语料 22 份 PDF 用户投放,文字层 22/22 健康。

## 下一步:P1(M15)知识编译闭环

范围(方案 §10 P1):MD/TXT/文字型 PDF 摄入 → 哈希去重/来源版本 → 断言抽取(DeepSeek)→ 别名归一(qwen)→ 本体校验 → 来源摘要/候选实体 → 两来源概念晋升 → 索引/日志 → 发布批次+DB 投影。验收:两来源建概念、重复来源不重复计数、raw 哈希不变。
建议拆 3-4 个派工(≈4-5 工作日):①schema 迁移(Vault 表族)②摄入管线(worker)③晋升+发布批次 ④端到端演练+报告。
