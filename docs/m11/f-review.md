# M11-F：M9–M10 补丁代码一体性审查报告

任务 ID：T-20260922-9f7195dc ｜ 只读审查，未改动任何源码 ｜ 2026-09-22

审查范围：kb-worker.ts（M10.5 并发补丁）、rag/embed.ts（批处理补丁）、orchestrator M10.6 tsc 修复（commit 161ff67，9 文件）、chat-service.ts + /api/models（M10.5-S3）、全局模式。

**总体结论：** 无 `as any` 遗留在 orchestrator（M10.6 用的是非空断言 `!` + 边界类型，属可辩护做法）；kb-worker 无 DBG/console.log 残留。发现的真问题集中在：chunkStrategy 类型断言吞错、sendChat 双重 resolve、/api/models 的 deepseek 硬编码、以及少量补丁痕迹。

---

## 1. apps/worker/src/kb-worker.ts（M10.5 并发补丁）

### 1.1 chunkStrategy 断言 + 宽 catch 掩盖真实错误 — **high**
- **位置：** `apps/worker/src/kb-worker.ts:123-126`
- **问题：** `job.chunkStrategy as StrategyName` 是无验证断言，随后 `catch { throw new PermanentRagError('UNKNOWN_CHUNK_STRATEGY') }` 把 chunkDocument 的**所有**异常（内存不足、内部 bug、超时）都永久化为 UNKNOWN_CHUNK_STRATEGY，不重试、且错误信息误导排查。
- **最小修法：** 不要 catch-all。改为在 chunkDocument 入口做策略名校验（或导出 `isStrategyName(x)` 谓词），仅对未知策略名抛 PermanentRagError；其余异常原样向上抛，交给 attempt 重试。

### 1.2 每个 loop 各自 embed 一条 'probe' — **low**
- **位置：** `apps/worker/src/kb-worker.ts:144`（`if (!probed) { await embed(['probe'], ...) }`）
- **问题：** 并发 N 时对同一 Ollama 发 N 条相同 probe，属于"每 loop 一份状态"的补丁式实现；可接受但答辩时可能被问。
- **最小修法：** 把 probe 提到 `runKbWorker` 顶部做一次（进程级），失败则整体退出交给重启策略。

### 1.3 readObject 每个任务新建 Minio Client — **low**
- **位置：** `apps/worker/src/kb-worker.ts:80-85`
- **问题：** 每次 getObject 都构造新的 `minio.Client`（含 TLS/agent），无连接复用；高吞吐时是隐性开销。
- **最小修法：** 模块级惰性单例（首次调用时创建，缓存 env 校验结果）。

---

## 2. packages/rag/src/embed.ts（批处理补丁）

### 2.1 固定 60s 超时与批大小解耦 — **low**
- **位置：** `packages/rag/src/embed.ts:21`
- **问题：** `EMBED_BATCH` 可配到很大（如 512），但超时固定 60s；大批次在慢机上必然 `EMBED_TIMEOUT`，且文档中无可发现的对应关系。
- **最小修法：** 超时按 `batchSize` 缩放（如 `30s + batchSize * 500ms`），或至少在 README/env 样例注明两者关系。属可辩护项，不修也可。

未发现其他真问题：批次长度校验（:36）、4xx/429/408 的永久/可重试分流（:29-34）逻辑正确，注释（:14）准确说明了重试预算语义。

---

## 3. orchestrator M10.6（commit 161ff67）

**结论：质量良好，无需修改的 high/med 问题。** 具体核验：

- 9 文件中**没有** `as any` / `as unknown`；类型绕过仅限非空断言 `!`（judge.ts:49/55-56/97-98/115、consensus.ts:7），每处均有前置长度检查且带解释注释——这是 strict 模式下的标准做法，不是绕过。
- `types.ts:23,31,43-44` 与 `collab.ts:41` 的 `?: T | undefined` 显式 undefined 是 exactOptionalPropertyTypes 的规范写法，非坏味道。
- `collab.ts:21-27` 新增 `CollabCallModel` 边界类型正确解决了签名不匹配，而不是断言强转。
- `index.ts:5-6` 收窄 context-builder 导出（`SeatConfig as ContextSeatConfig`）消除了同名冲突，合理。

### 3.1 `emit` 默认参数吞掉必需 payload — **low**
- **位置：** `packages/orchestrator/src/collab.ts:94`（`payload: Record<string, unknown> = {}`）
- **问题：** 为通过 strict 检查给 payload 加默认值，等于允许任何事件不带 payload 静默通过；类型上更诚实的修法是 `payload?: Record<string, unknown>` 并在使用处判空。
- **最小修法：** 改为可选参数 + 函数体内 `payload ?? {}`，或保持现状（行为等价，纯可读性）。

---

## 4. apps/web M10.5-S3（chat-service.ts + /api/models/route.ts）

### 4.1 sendChat 与 executeRunInline 双重 resolve — **med**
- **位置：** `apps/web/src/lib/chat-service.ts:113`（`resolver.resolve` 第一次）与 `:208`（第二次）
- **问题：** 同一 run 生命周期内 resolve 两次：两次 DB 往返；且降级事件可能重复——sendChat 已把 `meta.degraded` 写入 configSnapshot（:114,143），inline 路径的 `onResolved`（:211-218）和 `:220` 又会再 emit `run.degraded`，事件流里出现重复事件，答辩演示回放时可见。
- **最小修法：** sendChat 把第一次 resolve 的结果（含 resolved.modelId/adapter）传入 configSnapshot，executeRunInline 直接读取（`run.configSnapshot` 已含 modelKey/content/rag，顺带带上 resolve 结果即可），删掉 :208 的第二次 resolve。注意保留 `degradationReasons` 合并逻辑。

### 4.2 幂等重放逻辑整段复制 — **low**
- **位置：** `apps/web/src/lib/chat-service.ts:87-93` 与 `:156-162`
- **问题：** 同一段"读 configSnapshot 还原 messageId/meta"的 12 行代码出现两次（唯一约束竞态分支是复制粘贴）。
- **最小修法：** 抽 `toReplayResult(run: OrchestrationRun): SendChatResult` 私有函数，两处调用。

### 4.3 /api/models 硬编码 deepseek env 回退 — **med**
- **位置：** `apps/web/src/app/api/models/route.ts:23`
- **问题：** `model.providerId === 'deepseek' && process.env.DEEPSEEK_API_KEY?.trim()` 把特定 provider 名硬编码进通用模型列表接口；新增支持 env key 的 provider 时必须改这里（补丁痕迹明显，答辩易被指出）。
- **最小修法：** 在 ModelRegistry 的 Provider（或 capabilities JSON）上声明 `envKeyVariable` 字段，route 通用读取：`model.provider.envKey && process.env[model.provider.envKey]?.trim()`。过渡期最小版：至少把 `'deepseek'`/变量名抽成 `packages/providers` 导出的常量映射表。

### 4.4 capabilities 无校验断言 — **low**
- **位置：** `apps/web/src/app/api/models/route.ts:26`
- **问题：** `model.capabilities as { label?: string | undefined }`——仅取 label，风险低，但属"读 JSON 列随手 cast"模式。
- **最小修法：** zod `z.object({ label: z.string().optional() }).passthrough().safeParse`，失败回退 `model.modelKey`。低优先级。

### 4.5 测试路径 usage 写入 key 不一致 — **low**
- **位置：** `apps/web/src/lib/chat-service.ts:276-277`
- **问题：** `modelId: resolved?.modelId ?? modelKey`——生产路径写 registry row.id（resolver.ts:102），测试路径（providerFactory 置位时 resolved 为 undefined）写 modelKey，同一日用量被拆到两个 key。仅影响测试/内联演示数据。
- **最小修法：** 测试工厂注入时也统一传 registry id，或在此处断言 resolved 存在。

---

## 5. 全局（错误处理 / 日志 / 死代码）

- **DBG/console.log 残留：无。** worker 侧仅 `kb-worker.ts:148` 与 `main.ts:35` 两处 `console.error`，均带 `[kb-worker]`/`[worker]` 前缀，风格一致，可保留。
- **被注释掉的死代码：目标文件中未发现。**（`auth.ts:16` 注释中的 `as any` 是对已知缺口的文档化说明，且 `auth.ts:138` 的 `(prisma as any)[modelMap[model]]` 有明确解冻后即修的注释——属已知债务，不算本次补丁问题，但答辩若展示 auth.ts 需准备口径。）
- **错误处理模式：** `.catch(() => {})` 静默吞错（chat-service.ts:173,298,300,303,337）与 try/catch+console.error（kb-worker）两种风格并存。前者均伴随"先落终态再写事件"的注释说明（:295），意图明确；不建议为一致性重写，属可辩护设计。

---

## 汇总

| # | 文件:行 | 严重度 | 一句话 |
|---|---|---|---|
| 1.1 | kb-worker.ts:123-126 | high | 宽 catch 把 chunk 内部错误永久化为 UNKNOWN_CHUNK_STRATEGY |
| 4.1 | chat-service.ts:113,208 | med | 双重 resolve + 重复 run.degraded 事件 |
| 4.3 | api/models/route.ts:23 | med | deepseek/env-key 硬编码在通用接口 |
| 1.2 | kb-worker.ts:144 | low | 每 loop 重复 probe |
| 1.3 | kb-worker.ts:80-85 | low | 每任务新建 Minio Client |
| 2.1 | embed.ts:21 | low | 固定 60s 超时不随 batch 缩放 |
| 3.1 | collab.ts:94 | low | payload 默认 `{}` 弱化类型 |
| 4.2 | chat-service.ts:87/156 | low | 幂等重放 12 行复制 |
| 4.4 | route.ts:26 | low | capabilities 随手 cast |
| 4.5 | chat-service.ts:276 | low | 测试路径 usage key 不一致 |

共 10 项（1 high / 2 med / 7 low），每项均为核验过的真问题；orchestrator M10.6 修复整体质量良好。
