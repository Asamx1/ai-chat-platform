# M2 Durable Run 术语表

| 术语 | 英文 | 定义 | 在本项目的落地 |
| :--- | :--- | :--- | :--- |
| **租约** | Lease | Worker 对 Run 的临时执行权，TTL 30s | `OrchestrationRun.leaseOwner` + `leaseExpiresAt` |
| **原子领取** | Atomic Claim | 并发 Worker 安全领取，防止重复分配 | SQL: `FOR UPDATE SKIP LOCKED` |
| **续租** | Renew Lease | Worker 通过心跳延长 TTL，防止执行中断 | `renewLease` 每 10s 调用一次 |
| **检查点** | Checkpoint | 可恢复的运行状态快照，支持断点续传 | `RunCheckpoint(runId, version, stateJson)` |
| **Outbox 模式** | Outbox Pattern | API 只写命令到数据库，不直接执行，确保最终一致性 | Chat-service 写入 PENDING 状态的 Run 记录 |
| **幂等记账** | Exactly-once Accounting | 防止重复计费，确保资源消耗记录唯一性 | `ProviderCall.requestHash` 唯一 + `UsageLog.callId` 唯一 |
| **尝试次数** | Attempt | 恢复重试计数，控制最大重试上限 | 每次 Claim 后 attempt+1；当 attempt >=3 时不再领取 |