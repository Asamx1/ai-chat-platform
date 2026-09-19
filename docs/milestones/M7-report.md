# M7 里程碑报告 — 论文实验

日期：2026-09-26 · 状态：**完成**

## 实验执行总览

| 实验 | 设计 | 规模 | 耗时 | 结果文档 |
|---|---|---|---|---|
| exp1 预算匹配对照 | SINGLE-0.6b / SINGLE-7b / CONSENSUS(2弱+1强) × 48 题 × 3 repeats | 432 runs | 4.3 min | m7-exp1-results.md |
| exp2 消融 | CONSENSUS(1弱+2强) / SELF-CONSISTENCY(7b×3) / DEBATE(1轮) × 48 × 3 | 432 runs | 5.0 min | m7-exp2-results.md |

864 runs 全 SUCCEEDED、0 失败；数据集 hash 冻结（`2a7119204493e712`）；原始输出 `experiments/results/*.jsonl` 本地存档。

## 核心结果（Table-2 六条件）

| 条件 | acc | Wilson 95% | tokens/题 |
|---|---|---|---|
| SINGLE-0.6b | 0.375 | [0.30,0.46] | 7 |
| SINGLE-7b | 0.729 | [0.65,0.80] | 3 |
| CONSENSUS 2弱+1强 | 0.729 | [0.65,0.80] | 966 |
| CONSENSUS 1弱+2强 | 0.771 | [0.70,0.83] | 593 |
| **DEBATE 1轮** | **0.806** | [0.73,0.86] | 636 |
| SELF-CONSISTENCY | 0.708 | [0.63,0.78] | 9 |

## 论文叙事（四条实证结论）

1. 弱席协作不提升（exp1：0.729=0.729，McNemar p=1.0），且成本 322 倍
2. 席位质量>数量（弱→强换席 +4.2pp，-39% tokens）
3. 对抗结构最有效且 token 效率更高（DEBATE 全场最优 0.806）
4. SELF-CONSISTENCY 无效（0.708<0.729）：同模型多数票修不了系统性错误

诚实边界：trap 类协作无增益；48 题 McNemar 功效不足（p=0.29-0.38，扩样路径已写入局限）。

## 基建交付（实验平台即系统）

- fs ProgressStore（跨进程断点续跑）+ 判分归一化（stripThinking/全半角/候选抽取）
- collab-executor：实验条件直接复用 M4 durable 管线（事件/记账/匿名/降级全继承）——"系统=实验基础设施"论证闭环
- 统计套件（Wilson/McNemar/weighted kappa/bootstrap/mulberry32）14 用例已知答案自测

## 遗留（答辩前可选）

- exp3：200 题扩容 + 云端强席外推（seed 已留）
- 双人盲评材料（exp2 开放题输出抽样）
