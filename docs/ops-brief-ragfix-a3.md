# A3 — worker 执行路径 + 协作(collab)链路接入 RAG

【自动化模式】不要中途提问、不要读技能目录、不要浏览器对比、全部做完再退出。结束时在 result.md 写：改动文件清单、新依赖（应为无）、复用点、你跑过的验证命令与结果。

## 背景与根因（已实证，勿重复诊断）

两处链路没接知识库：

1. **worker 路径丢 RAG**：`apps/worker/src/runner.ts` 的 `processRun` 读 configSnapshot 只取 `{content, modelKey, userMessageId}`，`sendChat` 明明把 `rag` 快照存进了 configSnapshot，worker 却 `streamChat([{role:'user',content}])` 裸发——EXECUTION_MODE=worker 时 RAG 整体失效。参考实现在 `apps/web/src/lib/chat-service.ts` 的 `executeRunInline`（revalidateContext + injectContext 的用法照抄语义）。
2. **协作链路零 RAG**：`apps/worker/src/collab-runner.ts` 与 `apps/web/src/app/api/collab/run/route.ts` 全文无 retrieve/inject——协作席位永远看不到挂载知识库的内容。

## 任务

### 3a. worker 路径 RAG

在 `runner.ts` 的 processRun 中：
- configSnapshot 类型扩 `{ rag?: { status: string; hits: RagHit[] } }`（从 apps/web 的 rag-context 导出类型，或本地声明结构等价类型；**不要跨包 import apps/web**，把 RagHit/RagSnapshot 类型提升到共享位置或本地复制并注释来源）。
- 执行前若 `rag.status === 'READY' && rag.hits.length`，调用 `revalidateContext` 语义（可直接从 `@aichat/rag` retrieve 重新拉取后用 topHits 截断，或在 worker 内实现同款校验 SQL——**优先方案：worker 直接调用 `retrieve(userId, conversationId, content)` 重新检索**，因为 worker 拿 configSnapshot 里的旧 hits 无法 revalidate（那是 web 层私有函数）。重新检索一次成本可接受且永远新鲜）。
- 用 `injectContext` 同款语义把证据包进消息。注意：`injectContext` 也在 apps/web/lib 里——**把 injectContext/instruction/RAG_DATA 包装逻辑提为可复用**：新增 `packages/rag/src/inject.ts`（export `injectContext(messages, hits, capabilities)` 与 `RagHit` 兼容类型），apps/web 的 rag-context.ts 改为 re-export 该实现（保持 web 行为零变化），worker 引用 `@aichat/rag` 的新导出。citations 数组同样注入最终 assistant 消息（runner 收尾处 `citations: prompt.citations ?? []`）。

### 3b. 协作链路 RAG

- `collab-runner.ts` 的 processCollabRun：开跑时（构造 callModel 前）检索一次 `retrieve(run.ownerId, run.conversationId, effectiveContent)`（预算 10s，复用 A2 的 retrieve；若 status!=='READY' 或 hits 为空则跳过注入，**不降级不报错**，协作照常进行）。
- 注入策略：**同一份证据注入所有席位**。落点在 `callModel` 内构造消息处：在把 prompt 传给 orchestrator 策略前，将 `{role:'user', content: RAG_DATA 包}` 追加到该席位消息序列的 system 之后首条 user 之前（语义对齐 web 的 injectContext：system 在前、RAG_DATA 紧随、原始议题最后）。为每个 run 生成一次 nonce。
- 协作的 assistant 消息收尾 citations 保持 `[]`（协作产物是席位观点汇总，不逐条挂引用）——**不要**给协作消息挂 RAG citations，避免 UI 引用面板错乱。

### 3c. 前端超时提示

`apps/web/src/components/chat/` 中展示 degradationReasons 的位置（找 ChatApp 或消息气泡对 `run.degraded`/`degradationReasons` 的现有处理）：当 reasons 含 `RAG_UNAVAILABLE` 时渲染一条黄条："⚠️ 知识库检索超时，本次回答未参考知识库"。复用现有 CSS 类（如 degraded/warning 徽章），不新造样式体系。

## 硬约束

- 可改：apps/worker/src/runner.ts、apps/worker/src/collab-runner.ts、apps/web/src/app/api/collab/run/route.ts（如需）、packages/rag/src/index.ts 与新增 packages/rag/src/inject.ts、apps/web/src/lib/rag-context.ts（改为 re-export）、chat 前端组件一处。禁碰 packages/providers、packages/rag/src/retrieve.ts 的预算数字——A1/A2 地盘。
- packages/rag 新导出要在 index.ts 出口；相对导入不带 `.js` 后缀。
- 协作注入必须幂等：重试/恢复 run 时不得重复注入第二份 RAG_DATA（用 configSnapshot 存 nonce 或检测消息里已有 RAG_DATA_ 前缀）。
- exactOptionalPropertyTypes 全程注意。
- 不新增依赖。

## 验收

- worker 单测：mock provider + mock retrieve，断言 (1) rag.hits 非空时发给 provider 的消息含 RAG_DATA 包且议题仍在最后；(2) retrieve 抛错时协作/worker 不失败照常产出。
- collab 单测：双席位 fake orchestrator，断言两席位收到的 user 消息都含同一 RAG_DATA nonce。
- `npx vitest run --root apps/worker` 绿 + 受影响的 web 套件绿。
