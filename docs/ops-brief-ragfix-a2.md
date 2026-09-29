# A2 — RAG 检索预算扩容（rag-context + rag 包）

【自动化模式】不要中途提问、不要读技能目录、不要浏览器对比、全部做完再退出。结束时在 result.md 写：改动文件清单、新依赖（应为无）、复用点、你跑过的验证命令与结果。

## 背景与根因（已实证，勿重复诊断）

RAG 检索链 3 秒双层死线太紧：`apps/web/src/lib/rag-context.ts` 的 `deadline()` 外层 3000ms；`packages/rag/src/retrieve.ts` 内层 `Date.now() + 3_000`。热态实测全链 2805ms 贴线，冷态（首次懒加载 @aichat/rag + 模型冷启动）必超 → `RAG_UNAVAILABLE` → hits=[] → 知识库内容不进 prompt。用户症状："正常问答无法依据知识库回答"。

## 任务

1. **外层** `apps/web/src/lib/rag-context.ts`：两处 `deadline()` 超时 3000 → 8000。
2. **内层** `packages/rag/src/retrieve.ts`：`const deadline = Date.now() + 3_000` → 8_000。
3. **llm-json.ts 的硬编码 2_900**：`Math.min(2_900, budgetMs)` 中 2_900 → 6_000（rewrite/rerank 子预算上限，随剩余时间弹性）。
4. **超时降级可见性**：`retrieveContext` catch 后返回的 `RagSnapshot` 保持现状（status: 'RAG_UNAVAILABLE'）——前端展示由另一轨负责，你不要动前端。
5. 检查所有对 3000/3_000 的测试断言（grep `3_000\|3000\|2_900\|2900` packages/rag apps/web/test），同步把测试改为新预算口径；对超时行为本身的测试（如模拟慢 embed 触发 RAG_UNAVAILABLE）保留语义但用可注入的短预算（测试里通过 fake timers / 注入小 deadline）验证，不要靠真睡 8 秒。

## 硬约束

- 只改 apps/web/src/lib/rag-context.ts、packages/rag/src/retrieve.ts、packages/rag/src/llm-json.ts 及相关测试。禁碰 providers、worker、collab——A1/A3 地盘。
- 不改检索算法本身（RRF/MMR/hybrid 逻辑不动），只动预算数字与测试。
- 相对导入不带 `.js` 后缀；不新增依赖。

## 验收

- `npx vitest run --root packages/rag` 全绿；apps/web 相关套件绿。
- 新增一条用例：deadline 预算常量导出（如 `export const RETRIEVAL_BUDGET_MS = 8_000`）并在 rag-context 引用同一常量，断言两处一致（防再次漂移）。
