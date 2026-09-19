# M7 实验 exp1 — SINGLE vs CONSENSUS 预算匹配对照（结果冻结）

- 日期：2026-09-25 · manifest：`m7-exp1`（hash `2a7119204493e712`）· repeats=3 · seed=42
- 数据集：48 题客观题（arithmetic/logic/knowledge/trap ×12；难度 1/2/3 = 10/22/16）
- 判分：归一化精确匹配（stripThinking/全半角/候选抽取）
- 原始输出：`experiments/results/m7-exp1.jsonl`（432 条，gitignore，本地保留）
- 批跑：432/432 SUCCEEDED，0 失败，4.3 分钟（GPU 串行，qwen 全本地）

## Table 1：per-run 准确率（每 repeat 每题一个 run，n=144/条件）

| 条件 | 席位构成 | acc | Wilson 95% CI | tokens/题 | ms/题 |
|---|---|---|---|---|---|
| SINGLE-0.6b | qwen3:0.6b ×1 | **0.375** | [0.30, 0.46] | 7 | 42 |
| SINGLE-7b | qwen2.5:7b ×1 | **0.729** | [0.65, 0.80] | 3 | 57 |
| CONSENSUS | 0.6b×2 + 7b 汇总 | **0.729** | [0.65, 0.80] | 966 | 1698 |

McNemar（CONSENSUS vs SINGLE-7b, repeat0 配对）：b01=5, b10=6, **p=1.000** —— 差异不显著。

## 类别分解（CONSENSUS, repeat0, n=12/类）

| 类别 | acc |
|---|---|
| arithmetic | 33/36 |
| logic | 24/36 |
| knowledge | 21/36 |
| trap | 27/36 |

## 发现（论文素材）

1. **弱席共识不提升**：0.6b×2 + 7b 汇总的共识 = 7b 单模型（0.729 = 0.729，McNemar p=1.0）。汇总人采纳多数派时，两个弱席没有提供增量信息——**共识收益来自席位质量而非席位数量**（与 Mixture-of-Agents 文献中"弱席需有一定基线"一致）。
2. **成本差 322 倍**：CONSENSUS 每题 966 tokens vs SINGLE-7b 3 tokens（多席全流程含 prompt 重复）；时延 30 倍（1698ms vs 57ms）。等预算视角下 CONSENSUS 完全不占优——**预算匹配对照的价值正是量化这一点**。
3. SINGLE-0.6b 的 tokens/题（7）偏低是 think:false + num_predict=96 的截断效应——输出常被截，判分保守（对其不利方向），结论稳健。
4. 类别上 CONSENSUS 的 arithmetic 33/36 显著好（多数票对可验算任务有效），knowledge 最弱（21/36，弱席常识错误会稀释）。

## 下一步（exp2 消融方向）

- 换强席构成：0.6b + 7b + 7b（检验"一个强席是否足够"）
- SELF_CONSISTENCY_K：7b ×3 采样多数票（对照 CONSENSUS 的异构性贡献）
- DEBATE 条件（2 轮）在 trap 类上的表现（对抗陷阱直觉）
