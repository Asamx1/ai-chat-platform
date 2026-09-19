# ADR-004 运行执行模式切换：inline vs worker

## Status

已接受（2026-09，M2 起生效；inline 为过渡模式，计划 M4 移除）。

## Context

M1 采用 inline 同进程流式：请求线程内直接 await provider，事件随连接直推。实现简单、延迟最低，但执行生命周期与 HTTP 请求耦合：进程崩溃即 run 丢失、无重试、长任务占用请求线程、无法横向扩展。M2 引入 durable worker：run 以 DB 行持久化，worker 凭 lease 领取执行，事件落库后再分发，执行与请求解耦。过渡期两套路径并存，需明确切换机制、容量模型、租约参数与恢复语义。

## Decision

1. EXECUTION_MODE 环境变量（inline|worker），M2 起默认 worker；inline 仅保留用于本地调试与无 DB 单元测试。两模式差异收敛于调度入口，执行核心与事件写入共用同一实现，避免行为漂移。删除 inline 的条件：worker 在 dev/CI/预发稳定运行一个里程碑、且无 inline 独占的调试场景；目标 M4 移除，避免测试矩阵永久翻倍。

2. 容量：本地 Ollama 单模型实例本身串行处理请求，多 worker 并行只把竞争前移至 Ollama，吞吐不增、lease 冲突反增。故单实例并发上限 MAX_CONCURRENT_RUNS 默认 1；仅当 provider 可并行（云端 API）时才调高或增加 worker，且 worker 并发总数不超过 provider 可承受并发。

3. 租约：TTL 30s、每 10s 续租（TTL 的 1/3）。该比例容忍一次续租失败或进程停顿仍不丢租；10s 一次 DB UPDATE 对长 run 开销可忽略；30s 崩溃检测延迟相对分钟级 run 可接受。TTL 短于 15s 易因抖动误杀活 worker 致重复领取，长于 60s 则崩溃后用户可见延迟变差。

4. 恢复语义：事件传输 at-least-once——崩溃后 run 被重领、事件可能重发，消费端按 (run_id, seq) 幂等去重；记账与状态迁移 exactly-once——状态变更与计费在同一 DB 事务内以唯一约束加 run_version 乐观锁完成。论文表述为"at-least-once 投递 + 幂等消费，在可观测副作用层面达到 effectively-once"，并说明端到端 exactly-once 在分布式意义上不可达，本系统以事务边界界定恰好一次的范围。

## Consequences

正面：run 可恢复、可观测；请求线程释放；为云端 provider 的多 worker 扩展预留路径；inline 保留降低调试门槛。

代价：过渡期双模式维护与测试成本；单 worker 串行下排队延迟对用户可见，需 UI 呈现队列位置；最坏约 30–40s 崩溃检测延迟；消费端须实现去重，复杂度前移。

后续度量（M3）：lease 冲突率、续租失败率、重复事件率、崩溃恢复耗时，据此复核 TTL 取值与 inline 删除时点。

changed files：无（本会话无文件工具，按任务要求直接输出全文，未做任何文件系统改动）。

checks actually run：
- 四个决策点①②③④逐一核对均已覆盖；Status/Context/Decision/Consequences 四节齐全。
- 字数人工分段估算约 1050 字（含标点与英文术语），在 1200 字以内；无终端工具，未经 wc 精确统计。
- 未做 web 检索：内容为项目内部决策依据，任务上下文已提供全部必要事实，检索无增量价值。

remaining issues：
- 字数为人工估算，建议落盘后用 wc -m 复核（含 markdown 符号预计仍 <1200）。
- inline 删除时点（M4）与 TTL 参数待 M3 实测指标复核，存在调整可能。
- 本会话无法读取 E:/AI-Workstation/AGENTS.md 与 HERMES_ROUTING.md（无文件工具），如 ADR 编号/存放路径有既定约定，需由执行器落盘时确认。
- 未声明验收；是否满足"1200字 ADR"由验收方判定。
