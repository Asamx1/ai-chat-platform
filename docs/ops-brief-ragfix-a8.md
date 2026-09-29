# A8 — 对抗性回归审查(专攻并发/幂等/SSE)

【自动化模式】只读审查,不改任何文件。结束时在 result.md 输出攻击报告。

## 攻击面(与 A7 互补,A7 看功能正确性,你看破坏场景)

1. **quota 并发**:两个请求同时 reserve 同一 (userId,modelId,date),归一化后的代码是否仍正确串行化;fallback 后二次 reserve(本地模型 amount=0)与 advisory lock 顺序是否死锁。
2. **幂等重放**:ProviderCall requestHash 重放路径(QUOTA_OUTCOME_UNKNOWN/ settled replay)在改动后是否仍一致;worker 重试 attempt+1 时 RAG 注入 nonce 是否重复。
3. **SSE/前端**:RAG_UNAVAILABLE 黄条提示的渲染条件是否会与既有 degraded 徽章重复/冲突;collab 面板对新注入的 RAG_DATA 消息是否会把 nonce 文本泄漏到 UI。
4. **冷启动**:首次对话 8s 内 embed 模型还没加载完,超时后降级路径是否把 partial 状态留干净(无悬挂 reservedTokens)。
5. **EXECUTION_MODE 切换**:inline→worker 切换瞬间,同一 run 不会被双路径同时注入 RAG(lease 保护是否覆盖检索阶段)。

## 输出格式

每个攻击场景:复现条件 → 预期行为 → 实际代码行为 → 是否成立(成立=发现)。[severity] 标注。最后:通过的场景数/总场景数。
