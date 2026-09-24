# M16(P2)收官报告 — 本体驱动严格问答

> 日期:2026-09-25。状态:**P2 全部交付**。主仓 HEAD `c363633`,Vault 仓 rev-004(`5cd2bde`)。

## 评测曲线(59 题,六类型)

| 轮 | 准确率 | 关键变化 |
|---|---|---|
| r1 基线 | 50.8% | 拒答 16/18,检索层端口 bug 修复后 |
| r2 | 57.6% | 断言结构化(definition 为主) |
| r3 | 61.0% | 21/22 来源数据补齐,rev-004 |
| r5 | 64.4% | 向量召回+语义阈值 0.35 |
| **r6 终** | **67.8%** | 覆盖强化重抽,287 断言 |

分型终态:fact 9/13、synonym 4/8、single_source 6/11、version_scope 4/9、unanswerable 9/9、out_of_scope 8/9;拒答 17/18、误答 1、引用文件重合 28/52。

## 交付物(6 任务全 accepted)

1. query.ts 严格问答:实体链接→混合召回(词法+向量+线索词三通道)→受限回答→程序终检(结构性 grounding 门禁)
2. 检索与断言质量:结构化谓词抽取+reextractAll+别名扩展
3. 向量召回(bge-m3)+大文档分批抽取(159页 PDF 解锁)
4. 有限推理(subclass 传递/supersedes 传播/环检测)+VaultInferredAssertion+回答沉淀 answers.md
5. web 接入:/qa 页+/api/strict-qa(session 鉴权)
6. 覆盖强化:每 section 1-3 断言+--only-missing+线索词通道

## 质量门禁

- vitest 375 全绿(44 文件);typecheck 零新增
- 发布链:孤儿概念页下架(系统页)/人工页拒未知断言(防注入)/BASELINE 校验
- 严格性:无证据不调模型(语义阈值防向量垃圾召回)、单误答全程

## 已知限制(P3 候选)

- synonym 4/8:别称覆盖仍不足,需问题侧别名挖掘
- inferred=0:语料谓词全 definition/related_to,无传递链可推
- uses 关系大量被 RANGE 拒(Model 不在端点)——本体放宽需走规则变更流程
- /_global-error prerender 失败为 Node24+Next16 既有问题(基线对照)
