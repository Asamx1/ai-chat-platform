# A3 RAG 接入结果

已完成 worker 单聊 RAG、协作席位 RAG 和聊天检索超时提示；未新增依赖，未修改 providers 或 retrieve.ts 的预算。

## 改动文件

- `packages/rag/src/inject.ts`：从 web 提取 RagHit/RagSnapshot、证据指令、RAG_DATA 包装、TopK/预算裁剪和引用元数据转换。使用结构兼容的消息类型，不增加 providers 依赖。
- `packages/rag/src/index.ts`：导出共享注入函数及类型。
- `apps/web/src/lib/rag-context.ts`：重导出共享函数及类型，保留原检索、校验和消息顺序。
- `apps/worker/src/runner.ts`：READY 快照重新检索；共享注入；创建及恢复 assistant 消息均保存 citations，完成事件携带 citations；检索失败继续回答并记录 RAG_UNAVAILABLE，保留其他降级原因。
- `apps/worker/src/collab-runner.ts`：一次检索、所有席位/轮次共用证据及 nonce；system 后插入证据，检测已有 RAG_DATA_ 防止重复注入；失败静默跳过，最终 citations 仍为 []；备用席位使用自己的 system prompt。
- `apps/web/src/components/chat/ChatApp.tsx`：复用现有提示样式类显示黄色超时提示；支持 EventSource 降级事件和 POST 流完成后的持久化事件查询，切换会话/新发送时清除提示。
- `apps/worker/test/rag-runner.test.ts`：新增 7 个 mock 回归用例，覆盖新鲜证据、问题位置、恢复引用、双席位共享 nonce、异常继续执行、10 秒超时、重复注入和空检索。
- `apps/web/test/rag-fixture.mjs`：mock 保留真实共享注入函数，并适配配额 provider 边界。
- `apps/web/test/rag-chat.test.mjs`：更新旧断言，验证随机 nonce 及匹配的结束标记。
- `result.md`：本交付记录。

## 复用点与边界

复用 `@aichat/rag.retrieve`、web 原注入/预算/引用语义、worker 生命周期与租约逻辑、现有事件查询 API 和前端提示类。协作 API 已负责排队，无需重复检索或修改路由。

worker 外层等待上限为 10 秒；底层 retrieve 保持仓库原预算，未改动 A2 文件。协作异常不设置 RAG 降级标志。未进行浏览器操作或读取技能目录。

## 验证

安装：`corepack pnpm install --frozen-lockfile` 成功，锁文件与依赖声明均未改变；`npx prisma generate` 成功。

为隔离其他工作树，创建 `aichat_a3_test` 并执行 `npx prisma migrate deploy`，18 个迁移全部成功。worker 测试经 `/tmp/a3-test-env.mjs` 注入该专用数据库的 DATABASE_URL/AICHAT_TEST_DB_URL 和 NODE_ENV=test，不在报告记录凭据。

- `node /tmp/a3-test-env.mjs npx vitest run --root apps/worker`：9 个文件、45 个测试通过（包括新增 7 个 RAG 用例）。
- `npx vitest run --config apps/web/vitest.config.ts`：15 个文件、150 个测试通过。
- `node apps/web/test/rag-chat.test.mjs`：11/11 通过。
- `node apps/web/test/citations.test.mjs`：6/6 通过。
- `node apps/web/test/rag-api.test.mjs`：17/17 通过。
- `node apps/web/node_modules/typescript/bin/tsc -p apps/worker/tsconfig.json --noEmit`：通过。
- `node apps/web/node_modules/typescript/bin/tsc -p packages/rag/tsconfig.json --noEmit`：通过。
- `node apps/web/node_modules/typescript/bin/tsc -p apps/web/tsconfig.json --noEmit --incremental false`：通过。
- `git diff --check`：通过。

验证过程说明：首次 `pnpm` 不在 PATH，改用 corepack；根目录 `npx tsc` 没找到工作区 TypeScript，改用已安装编译器。回归发现并修复备用席位 system prompt 和旧 RAG mock/nonce 断言问题。一次全量 worker 重跑中既有 fault-matrix 租约接管时序用例偶发返回 null，未修改该测试或租约逻辑，随后独立重跑全量 45/45 通过。
