# A1 — quota 降级误判修复（providers 包）

【自动化模式】不要中途提问、不要读技能目录、不要浏览器对比、全部做完再退出。结束时在 result.md 写：改动文件清单、新依赖（应为无）、复用点、你跑过的验证命令与结果。

## 背景与根因（已实证，勿重复诊断）

普通对话选 DeepSeek 云模型时 100% 被误判 QUOTA_EXCEEDED 降级到本地 qwen。根因两处：

1. `packages/providers/src/resolver.ts` 的 `result()` 返回 `adapter: row.adapter ?? row.provider.kind`，数据库 Provider.kind='deepseek'，所以 `resolved.adapter === 'deepseek'`。
2. `packages/providers/src/quota-provider.ts:38` 判断 `resolved.adapter === 'openai-compatible' && resolved.provider === 'deepseek'` → 永假 → `inputTokenUpperBound` 恒 undefined → cloud 模型一律 `fallback(modelId, 'QUOTA_EXCEEDED')`。
3. 附加坑：`packages/providers/src/openai-compatible.ts:71` `inputTokenUpperBound` 只对 `this.model === 'deepseek-chat'` 定义，deepseek-reasoner 修完前两条仍会降级。

## 任务

1. **resolver.ts 归一化 adapter**：非 ollama 的云模型 adapter 归一为 `'openai-compatible'`（即 `row.adapter ?? (row.provider.kind === 'ollama' ? 'ollama' : 'openai-compatible')` 语义）。注意保持 ollama 分支不变，`quota-provider.ts` 的 `build()` 与 chat-service 等既有 `adapter === 'ollama'` 判断不能被破坏。
2. **quota-provider.ts 判断改双保险**：上行的 bound 判断改为 `resolved.kind === 'cloud' && resolved.provider === 'deepseek'`（不再依赖 adapter 字符串）。
3. **openai-compatible.ts 放宽 bound**：`inputTokenUpperBound` 覆盖 `this.model.startsWith('deepseek')` 全系（字节上界公式不变）。
4. **检查存量测试**：grep `adapter` 在 `packages/providers/test/` 与其它包（web/worker/experiments）对 `'deepseek'` 字符串的断言，同步修正（这些测试之前测的是 bug 行为）。

## 硬约束

- 只改 packages/providers/（及其测试）；禁碰 packages/rag、apps/、packages/db schema——那是 A2/A3 的地盘。
- 相对导入一律不带 `.js` 后缀（本仓 Turbopack 坑）。
- exactOptionalPropertyTypes：可选字段显式 `?: T | undefined`。
- 不新增依赖。

## 验收（你会跑，编排方还会重跑）

- `cd /home/codex/code/ai-chat-platform/repo && npx vitest run --root packages/providers`（或仓内对应跑法）全绿。
- 手工断言（写成 vitest 用例）：resolver 对 Provider.kind='deepseek' 的行返回 adapter='openai-compatible'；quotaProvider 对 deepseek-chat/deepseek-reasoner 均不再触发 QUOTA_EXCEEDED fallback（mock db 里 usage 低于 limit）；inputTokenUpperBound 对 deepseek-reasoner 返回数字。
