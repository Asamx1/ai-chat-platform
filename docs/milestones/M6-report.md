# M6 里程碑报告 — 实验平台

日期：2026-09-24 · 状态：**完成** · HEAD：见 git log

## 交付物（PLAN §12-M6 对照）

| 任务 | 实现 | 证据 |
|---|---|---|
| 批量 runner | batch-runner.ts：断点续跑（taskKey 命中 SUCCEEDED 即 skip）、worker-pool 并发、失败重试（maxRetries）、AbortSignal→CANCELLED、注入 clock 确定性时间戳 | batch-runner.test 6 用例 |
| 实验 manifest | configs/schema.ts（zod）：5 条件枚举、budget、repeats、seed、dataset hash 校验（16-64 hex）、example + 首个正式配置 m6-smoke-001 | schema.test 7 用例 |
| 结果 schema | runners/result-schema.ts：status 枚举 + output.usage + metrics（ttft/total） | 同上 |
| 数据集冻结 | datasets/m6-smoke-v1.jsonl：12 道客观题（算术/逻辑/常识），sha256 前 16 位 `a1971fb1437ce634` 写入 manifest | smoke-real hash 复核断言 |
| 统计脚本 | analysis/stats.ts：Wilson CI / McNemar 精确 / 二次加权 kappa / bootstrap 均值差 CI / mulberry32 | stats.test **14 用例已知答案** |

## 验收证据（PLAN M6 出口对照）

| 出口标准 | 结果 |
|---|---|
| 相同配置重复执行可追踪 | ✅ smoke-real：第一遍 12 任务全 SUCCEEDED；第二遍全部 skip（skipped=12, succeeded=0，executor 抛错兜底证明未执行） |
| 统计测试使用已知答案的合成数据通过 | ✅ stats.test：McNemar (3,22)→p=0.000157 精确值；kappa 完全一致=1/独立≈0/系统性偏移中值；bootstrap 同种子可复现 |

## 真实管线冒烟（smoke-real.test.ts，本地 Ollama）

manifest 校验 → 数据集加载 + hash 复核 → batch-runner 驱动 qwen3:0.6b（SINGLE 条件 12 题）→ RunResult 内存 store → 客观题判分 → Wilson CI 汇总。
结果：**5/12（42%）,Wilson95 [0.19, 0.68]**。管线端到端贯通；CONSENSUS/DEBATE 条件留给 M7 正式实验。

## 已知限制（转 M7）

1. qwen3 系列默认 thinking 模式会吞掉 num_predict 预算 → 已用 `think:false`；正式实验需按模型配置化
2. store 为内存实现；M7 需文件系统 store（results/ 目录 jsonl 落盘）
3. 判分用 includes 简单匹配；正式实验需归一化（去空格/全半角/数字提取）

## 测试矩阵

experiments 4 套件（schema 7 + batch 6 + stats 14 + smoke-real 1）= 28 用例；全仓 13 套件 + web 5 + worker 5 全绿。
