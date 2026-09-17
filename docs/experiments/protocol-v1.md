# 实验 Protocol v1（M0 冻结）

> 依据 PLAN.md §11。任何修改必须记录版本与理由。

## 1. 对照条件（等 token 预算 + 自然预算各一组）

| 编号 | 条件 | 说明 |
|---|---|---|
| C1 | Single-1 | 最强单模型一次调用 |
| C2 | SelfConsistency-K | 同模型 K 次采样后汇总（K 预注册，默认 5） |
| C3 | Parallel-Heterogeneous | 异构模型并行后汇总 |
| C4 | Consensus | 共识协议 |
| C5 | Debate-2R | 辩论，轮次上限 2 |

## 2. 配置冻结字段（每次实验 manifest 必填）

- 应用 commit SHA、lockfile hash（`pnpm-lock.yaml` 的 SHA-256）
- 每个模型：provider、modelKey、digest（Ollama `ollama show` 或云模型版本字符串）
- prompt hash（SHA-256）、温度、top-p、max context、max output、随机种子
- 数据集：名称、版本、license、split、样本清单 SHA-256、排除规则
- 预算：token 上限、费用上限、超时

## 3. 执行规则

- 每条件至少重复 3 次；样本量由 power analysis 决定（M6 补算）。
- 原始输出、候选顺序、失败、重试、人工评分全部保留，不删除不利结果。
- 故障注入实验与质量实验分开运行、分开报告。

## 4. 指标

- 客观题：accuracy / exact match / McNemar / 效应量 / 95% CI
- 开放题：双人盲评，weighted kappa（有序）或 ICC（连续）
- 性能：TTFT、tokens/s、p50/p95 总时延、排队时间、模型加载时间
- 成本：云 API 实付、token、能耗估算、墙钟时间分开报告
- 可靠性：恢复成功率、事件重复/丢失数、重复记账数、失败与降级率

## 5. 数据目录规范

```
experiments/
├── configs/    # 冻结的实验配置（入 Git）
├── datasets/   # manifest 与 hash，受限原文不入 Git
├── runners/    # 批量执行脚本（入 Git）
├── analysis/   # 统计与绘图脚本（入 Git）
└── results/    # 原始输出与导出摘要（.gitignore，实体在 D:\ai-chat-data\experiments）
```

- 每次运行产出一个 `<expId>/<runId>/` 目录：config.json、events.jsonl、calls.jsonl、metrics.json。
- 统计脚本只读 results，不写；图与表输出到 `analysis/out/`。
