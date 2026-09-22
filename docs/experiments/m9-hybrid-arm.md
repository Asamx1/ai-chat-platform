# M9-S9c 分块策略对照（hybrid 臂 vs 纯向量臂）

- 运行时间：2026-09-22T01:35:15.068Z
- 检索：BM25（k1=1.5, b=0.75，CJK bigram+拉丁分词）+ bge-m3:latest 余弦 → RRF k=60 → MMR λ=0.5 → top-5 · 判分：qwen3:8b（temp=0, json）· 60 QA
- 纯向量基线来源：experiments/results/m9-chunk-compare.json

| 策略 | chunks | 纯向量 hit@5 (Wilson 下界) | hybrid hit@5 (Wilson 下界) | Δ hit@5 | 平均分 | 判分回退 |
|---|---|---|---|---|---|---|
| structure | 77 | 58/60 (96.7%) (0.886) | 59/60 (98.3%) (0.911) | +1.7pp | 4.85 | 0 |
| recursive | 61 | 56/60 (93.3%) (0.841) | 59/60 (98.3%) (0.911) | +5.0pp | 4.9 | 0 |
| fixed | 40 | 57/60 (95.0%) (0.863) | 60/60 (100.0%) (0.940) | +5.0pp | 4.883 | 0 |

## 结论

hybrid 臂在 3/3 个策略上提升 hit@5；受益最大的是 **fixed**（Δ +5.0pp）。各策略 Wilson 95% 区间宽度约 ±8pp（n=60），小于 8pp 的提升应视为与噪声不可区分。逐 QA 原始行与完整配置见 m9-hybrid-arm.json。
