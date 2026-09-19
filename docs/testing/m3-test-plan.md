# M3（协作核心一）测试计划

## 一、范围与优先级矩阵

| 模块 | 对应验收 | 优先级 | 测试类型 |
|---|---|---|---|
| 群聊/共识策略（fake provider） | ① 事件快照稳定 | P0 | 单元+快照 |
| context-builder / budget | ④ 预算耗尽降级 | P0 | 单元 |
| GPU admission / queue | ③ 20 并发无 OOM | P0 | 压测 |
| 协作 run API + worker | ② 三席真实协作完成 | P1 | e2e |
| 席位失败降级 | ④ | P0 | 集成 |

执行顺序：fake 快照 → budget/queue 单元 → 三席 e2e → 并发压测。

## 二、策略事件快照测试方案

确定性三要素：fake callModel 用脚本化响应表（按"调用序号+seat"返回固定文本，不做 prompt 语义判断）；逻辑时钟（step 自增替代 wall-clock）；固定 run_id、seat_id、seed。

断言对象不是消息文本，而是策略层吐出的结构化事件流：seat_speak / consensus_propose / consensus_vote / round_end / budget_consume / run_finish。每事件只保留确定性字段，payload 取内容 hash，时间戳归一化为逻辑序号。

快照格式建议：tests/snapshots/<case>.snap.jsonl，首行 meta（config_hash、seed、策略版本），之后每行：
{"seq":0,"type":"seat_speak","seat":"A","round":1,"digest":"sha256:..."}
判定：同配置连跑 3 次，事件序列与 digest 全等；不等时输出首个分叉事件的 diff 定位。用例集：多数共识、否决、超时跳轮、预算中途耗尽、单席空响应，共 5 条。

## 三、三席真实协作 e2e 方案

席位选型：qwen3:0.6b × 2 做提案席 A/B + qwen3:1.7b 做仲裁席 C。不建议更大模型（如 qwen3.6 级）：仲裁只做一致性判断，1.7b 足够；三席总显存 <4GB，保证单卡 8GB 或 CPU offload 环境可跑。

任务固定为小颗粒："给函数起 3 个名字并投票选其一"，max_rounds=3 保证可终止。

延迟预算定法：先在目标机器单席跑 5 次基准（≤256 token 生成），取 p95×1.5 作单轮预算（参考值 30s）；单轮协作（3 席+共识）90s；整 run 上限 180s，超时判失败并记录耗时分布。

断言：run 状态=completed 且有 final_answer；事件流含 ≥1 次 consensus_reached；每席至少发言 1 次；总耗时低于预算。

## 四、GPU 队列 20 并发压测方案

模拟领取：async 脚本同一时刻向 run API 发 20 个请求，worker 池按 admission 上限（如 max_concurrent=2）领取。主体用 fake provider 控显存，避免压测自身 OOM 污染断言；另做 1 组 4 并发真实小模型冒烟，验证 admission 计数对真实显存生效。

可观测面与断言：
- 队列计数：任意时刻 running ≤ max_concurrent；running+queued+done 恒=20；无丢失、无重复领取。
- 显存：周期采样 memory_reserved，峰值 < 卡容量 90%，且无单调增长（泄漏判定）。
- 进程：RSS 增量在阈值内；stderr/日志中 CUDA OOM、OOM killer 关键字出现次数=0。
- 正确性：20 个 run 的事件集合与串行执行等价（允许乱序，不允许缺失）。
失败判定：任一 OOM、60s 无进度（死锁）、计数越上限，任一发生即不通过。

## 五、降级矩阵

| 场景 | 注入方式 | 预期行为 | 断言 |
|---|---|---|---|
| 单席失败/超时 | fake 对该席抛异常 | 跳过该席，发 seat_skipped，其余继续 | run 完成且状态标 degraded |
| 全部席失败 | 全部抛异常 | run=failed，错误码明确，重试 ≤ 上限 | 失败事件落库，无重试风暴 |
| 预算耗尽 | budget 设为 1 轮 | 当轮收尾后停止，发 budget_exhausted，不开新轮 | token 计数 ≤ 预算 |
| 模型不可用 | provider 连接拒绝 | 健康检查失败，run 快速失败或排队，不空转 | 状态+错误码断言 |
| 仲裁席失败 | 仅 C 抛异常 | 降级为多数票/首提案，发 degraded_consensus | 有产出且带降级标注 |

## 六、风险

1. fake 与真实 provider 行为漂移：快照过不代表真实可用，靠 e2e 兜底；e2e 需 pin 模型版本 digest，否则升级即红。
2. 0.6b 共识质量差、可能不收敛：max_rounds 硬上限 + 无共识也产出（标 no_consensus）。
3. 压测环境差异：显存断言用相对阈值（<90%），报告中注明实测机型。
4. 快照脆弱性：只 hash 结构字段，措辞类文本走抽样人工审，避免全红。
5. 20 并发只验证 admission 正确性，不代表吞吐达标；吞吐指标另立里程碑。

---
result：上方 M3 测试计划全文（约 1450 字）。
changed files：无（按任务要求直接输出 markdown）。
checks actually run：无工具调用；本任务为纯规划输出，术语与范围均取自任务给定文本，无外部事实需核验。
remaining issues：①qwen3:1.7b 仲裁席与延迟预算数值为建议值，需在目标机器跑基准后回填实测 p95；②max_concurrent=2、显存 90% 阈值为占位，需按实际卡型确认；③快照事件类型清单（seat_speak 等）需与策略层实际事件名对齐。
