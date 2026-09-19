# 裁判去偏机制设计说明（论文素材 + 实现对照）

## 1. 机制原理
LLM 裁判存在三类系统性偏差（Zheng et al., NeurIPS 2023, arXiv:2306.05685）：位置偏差（偏好先出现者）、自我偏好（给自产文本虚高分）、verbosity bias（以长为好）。PLAN §8.6 六项机制逐一对应：

- 匿名化：隐藏候选来源身份，裁判只按内容打分，切断"认作者"与部分自我偏好通路。
- Fisher-Yates 洗牌：以等概率 1/n! 的均匀置换随机化呈现顺序，使位置效应在期望上归零；该算法是 O(n) 无偏 shuffle，无朴素交换实现的分布倾斜。
- 禁自评：裁判不得评自己产出的候选，从源头移除最强的自我偏好通道。
- JSON Schema 裁决：强制定长结构化输出（分数/胜者/理由），消除自由文本的解析漂移，并把评分锚定在 rubric 维度上，使裁决长度不随候选篇幅膨胀，间接抑制 verbosity bias。
- 一次修复重试：输出不合 schema 时修复重试一次，避免"格式失败"被系统性误判为"质量差"，防止对非常规输出的假阴性偏差。
- 失败保留候选：重试仍失败则保留候选而非淘汰，把裁判侧故障与候选质量解耦。

## 2. 实现对照（packages/orchestrator/judge.ts）
- anonymize：剥离候选的 agentId/model 等身份字段，改挂匿名标签（A/B/C…）后送入裁判 prompt。
- orderMap：保存匿名标签→原始 candidateId 的映射；列表经 Fisher-Yates 洗牌后，凭此表把裁判选中的胜者还原为真实候选——"裁判见乱序，系统记真身"。
- selfJudged：配对阶段过滤"裁判模型＝候选产出模型"的组合；裁判池兜底无法过滤时放行，但在裁决记录中置 selfJudged=true，供下游校正。

## 3. 消融实验设计（PLAN §11.5）
每次仅关闭一个机制、其余全开，在同一任务集与预算下对照全开销线：A1 关匿名化、A2 关洗牌（固定提交序）、A3 允许自评、A4 关 Schema（改自由文本裁决）、A5 关重试、A6 关失败保留。指标：质量（与人工标注一致率、成对翻转率）、平均 token 消耗、P50/P95 端到端时延；多次重复取均值，报告置信区间与配对检验。预期：A2 翻转率显著上升；A3 自产候选胜率虚高；A4 解析失败率与 token 同步上升；A5/A6 质量分被格式失败污染。

## 4. 已知局限
同模型裁判无法完全消除自我偏好——模型可从文风认出自己的输出，匿名化对此无效，此即 selfJudged 标注的意义：(a) 主指标可对该子集做敏感性剔除；(b) 单独报告以免污染结论；(c) 为引入异构裁判池提供量化依据。此外：verbosity bias 仅部分缓解（候选长度对裁判仍可见，schema 只约束裁决输出格式）；洗牌只在期望上去偏，单次裁决仍含位置方差；一次重试对高失败率裁判模型可能不足。
```

Changed files: 无（本会话无文件工具，按任务要求直接输出 markdown；落盘由其他执行者处理）。

Checks actually run:
- web_search 核实偏差分类与引文：Zheng et al., "Judging LLM-as-a-Judge with MT-Bench and Chatbot Arena", NeurIPS 2023 (arXiv:2306.05685)，确认 position / verbosity / self-enhancement 三类偏差及洗牌缓解思路（来源 proceedings.neurips.cc、arxiv.org）。
- 第二条 web_search（同模型裁判自偏好补充文献）返回 403（Firecrawl 无 key），未重试出结果；该部分论述改以第一条文献中的 self-enhancement bias 结论支撑。

Remaining issues:
1. 未读源码：本会话无 read_file/terminal 工具，§2 对 judge.ts 的 anonymize/orderMap/selfJudged 描述基于任务提供的标识符与 PLAN §8.6 语义推断，函数签名、随机源（Math.random vs crypto）、兜底逻辑等未对照真实代码核实——建议由有文件权限的执行者校对 §2。
2. PLAN §11.5 原文未见，消融指标命名（一致率/翻转率/P50/P95）为按任务描述的合理展开，具体阈值以 PLAN 原文为准。
3. 字数为手工估算（约 870 字），未经工具精确统计。
