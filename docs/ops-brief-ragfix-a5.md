# A5 — A2 轨配套测试（RAG 预算，先红后绿）

【自动化模式】不要中途提问、不要读技能目录、不要浏览器对比、全部做完再退出。结束时在 result.md 写：新增测试文件清单、覆盖点列表、你跑过的命令与结果。

## 背景

A2（另一工作树并行修复中）把 RAG 检索预算 3s → 8s（rag-context 外层、retrieve 内层、llm-json 子预算 2900→6000）并导出统一常量。你的工作树不含 A2 修复，先写测试预期红。

## 任务

1. `packages/rag/test/` 新增 `budget.test.ts`：
   - 断言 `@aichat/rag` 导出 `RETRIEVAL_BUDGET_MS === 8_000`（基线上无此导出，红）。
   - 断言 retrieve 的 deadline 来自该常量（可通过慢 mock embed + fake timers 观察超时阈值，或直接断言源常量被引用——选择可维护的一种）。
2. `apps/web/test/` 新增 `rag-context-budget.test.mts`（对齐该目录既有后缀风格）：
   - 断言 rag-context 的 deadline 为 8_000（同样基线红）。
   - 语义测试：embed 慢 4s 但 <8s 时 retrieveContext 返回 READY 且有 hits（mock @aichat/rag 的 retrieve 延时 resolve；基线上 3s 死线会把它判 RAG_UNAVAILABLE，红；A2 合并后绿）。
3. **不写真睡测试**：一律 fake timers / mock 延时，不许 setTimeout 真等 8 秒。

## 硬约束

- 只动 packages/rag/test/ 与 apps/web/test/。禁碰一切 src/。
- vi.mock 同包实例坑注意：测试文件与被测代码同包。
- 不新增依赖。

## 验收

- 基线上 1-2 的红测输出贴进 result.md。
- 既有套件不假红。
