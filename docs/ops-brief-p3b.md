# P3/M17 任务②:撤回传播 + 推理依赖失效重算 + 版本时效标记

【自动化模式】不要中途提问、不要读 skill、不要浏览器操作;全部做完再退出。自由用文件工具读源码;禁跑构建命令(pnpm/npx/prisma/tsc/vitest/node),写完即止,验收由编排方本地实测。

## 背景(编排方实测)

任务①已交付 WikiJob/lint/scan-backlog(commit 7fc9347)。本任务做方案 §5.3 的传播类维护:
- 「前提撤回→使受影响推理失效并重算」
- 「规则更新→使受影响推理失效并重算」
- 「时间与版本:旧模型信息被用于新版本→标记适用范围与待核实状态」
- 「概念门槛:有效独立来源数不足两份→标为候选/待复核并更新索引,不悄悄删除历史」

现状:VaultInferredAssertion 表已有(P2-④,含 premisesJson/derivedFrom/rulesVersion);VaultAssertion 有 status(candidate/supported/retired?);VaultRelease 记录 ontologyVersion;promote.ts 的 eligiblePromotions 判晋升门槛。

## 交付物

1. **packages/wiki/src/maintenance.ts**:
   - `propagateRetraction(assertionId, db)`:人工/系统撤回一条 source 断言 → 置 retired → 找出引用它为 premise 的 VaultInferredAssertion → 级联失效(置 invalid,记录 invalidatedBy/reason)→ 若被失效推理被 answers 沉淀引用,标记 answer 页 stale(写 markdown front-matter 或 sidecar)
   - `recomputeInferences(vaultId, db, opts)`:全量重算——先失效全部 inferred(保 premisesSha 指纹避免无谓抖动),再调 infer.ts 的 inferAssertions 重建;输出 {invalidated, rebuilt, unchanged}
   - `markVersionStaleness(vaultId, db)`:对 supersedes 关系(A supersedes B)下,subject=B 的断言若 evidence 的 source 时间晚于 supersedes 断言建立时间 → 报「旧实体收到新信息,疑似应挂在新版本上」(lint warn 级,不自动改)
   - `demoteLonelyConcepts(vaultId, db)`:已晋升概念页(promoted)若有效独立 source family 数 <2(以当前 supported 断言计算)→ 实体状态改回 candidate 待复核+返回需从 index 移除的页清单(不删文件——文件处理由发布器 retire 路径管)
2. **maintenance CLI**(packages/wiki/scripts/maintenance-vault.mts):子命令 recompute-inferences/retract --assertion-id/staleness/demote;输出 JSON
3. **测试**(packages/wiki/test/maintenance.test.ts,真库 fixture 参考 publish.test.ts):
   - retract 一条 premise → inferred 级联 invalid,重算后不复活(除非 premise 恢复)
   - recomputeInferences 幂等:连续两次第二次 unchanged>0
   - markVersionStaleness:A supersedes B + B 收到更晚 evidence → 1 条 warn
   - demoteLonelyConcepts:构造 2 源晋升后删 1 源断言 → 概念降回 candidate 且页在移除清单

## 边界

- 不改 prisma schema(VaultInferredAssertion 已有字段够用;若确需新字段,写迁移 SQL 但禁跑 prisma 命令并在 result 里声明)
- 不自动发布;不删任何 vault 文件
- infer.ts 接口以现状为准(读它,别猜)

## 参考文件

packages/wiki/src/infer.ts(premises 结构)、jobs.ts(事务模式)、lint.ts、publish.ts(retire 路径)、promote.ts(eligiblePromotions 门槛)、test/publish.test.ts(fixture)
