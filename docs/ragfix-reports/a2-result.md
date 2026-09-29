# A2 RAG 检索预算扩容结果

已完成：检索与复验外层 deadline、检索内层 deadline 共用 `RETRIEVAL_BUDGET_MS = 8_000`；LLM JSON 请求默认预算和硬上限调整为 6_000ms，并继续受调用方剩余预算约束。超时仍返回 `{ status: 'RAG_UNAVAILABLE', hits: [] }`。

## 改动文件

- `apps/web/src/lib/rag-context.ts`：两个调用入口的 deadline 共用 8 秒常量。
- `packages/rag/src/llm-json.ts`：定义无依赖的共享预算常量；请求默认预算与上限改为 6 秒。
- `packages/rag/src/retrieve.ts`：使用并重新导出共享常量；原有 index 的 export-star 自动公开该常量。
- `apps/web/test/rag-context.test.ts`：新增检索、复验 8 秒边界与降级测试，以及超过旧 3 秒预算仍成功的回归用例。
- `apps/web/test/rag-chat.test.mjs`：真实等待改为 Node mock timers；同步现有随机引用分隔符断言。
- `apps/web/test/rag-fixture.mjs`：补齐现有 quota-provider 入口的模拟，复用原 OllamaProvider 模拟，恢复聊天集成测试的 provider 边界隔离。
- `packages/rag/test/retrieve.test.ts`：调整增强检索超时回退、剩余不足一秒跳过 rerank 的时间；新增共享常量及慢 embed 超时边界断言。
- `packages/rag/test/rerank.test.ts`：显式传入 6 秒预算并以虚拟时钟验证中止与回退。
- `packages/rag/test/llm-json.test.ts`：覆盖默认 6 秒、调用方 8 秒被封顶、40ms 短预算，以及响应体读取超时与 abort。
- `packages/rag/vitest.config.ts`：使用包内相对测试路径，使简报指定的 `--root packages/rag` 命令能发现所有测试。
- `result.md`：本报告。

## 新依赖

无。使用 `npx --yes pnpm@10.34.5 install --frozen-lockfile` 安装仓库已有依赖，未修改 package.json 或锁文件。

## 复用点与范围

- 常量放在现有无依赖的 llm-json 模块；Web 直接引用该模块，保留 `@aichat/rag` 的懒加载。相对导入无 `.js` 后缀。
- 复用原有 deadline / beforeDeadline、Promise.race、AbortController、错误降级机制和测试夹具。
- Node mock timers 与 Vitest fake timers 验证超时，不真实等待 8 秒。
- 不修改 RRF/MMR/hybrid、前端展示、providers、worker、collab 的实现。
- 已检查 `3_000|3000|2_900|2900`：剩余匹配是 URL 端口、超长输入长度，以及范围外 rewrite/rerank 的独立调用默认参数。实际 retrieve 链已显式传入剩余预算；保留其默认参数符合只改指定实现文件的约束。

## 验证命令与结果

最终通过：

- `npx vitest run --root packages/rag`：16 个文件，153 条通过。
- `npx vitest run packages/rag/test`：16 个文件，153 条通过。
- `npx vitest run --config apps/web/vitest.config.ts apps/web/test/rag-context.test.ts`：3 条通过。
- `npx vitest run --config apps/web/vitest.config.ts`：16 个文件，153 条通过。
- `node apps/web/test/rag-api.test.mjs && node apps/web/test/rag-chat.test.mjs && node apps/web/test/citations.test.mjs`：17 + 11 + 6 条全部通过。
- `git diff --check`：通过。
- `rg -n '3_000|3000|2_900|2900|2800|2_100' packages/rag apps/web/test`：完成旧预算引用检查，说明见上。

前置失败及解决：

- 安装前运行 Vitest/Web 测试：缺少本地依赖；npx 临时选择了 Vitest 5。按锁文件安装后使用仓库 Vitest 3.2.4，通过最终验证。
- `pnpm install --frozen-lockfile`：环境无 pnpm 命令；改用上述固定版本 npx 命令安装成功。
- 安装后首次 `npx vitest run --root packages/rag`：继承仓库根配置的 include，找不到测试；新增包内测试配置后通过。
- 首次 Node 聊天测试遇到真实 provider 模块的 TypeScript parameter property；诊断用 `node --experimental-transform-types apps/web/test/rag-chat.test.mjs` 又显示夹具缺失 provider 所需数据库方法。补齐测试夹具的 quota-provider 模拟后，普通 Node 命令全部通过。

未执行真实模型或数据库端到端调用；本次验证范围为上述自动化测试。
