# A6 — A3 轨配套测试（worker/collab RAG 注入，先红后绿）

【自动化模式】不要中途提问、不要读技能目录、不要浏览器对比、全部做完再退出。结束时在 result.md 写：新增测试文件清单、覆盖点列表、你跑过的命令与结果。

## 背景

A3（另一工作树并行修复中）给 worker 执行路径与协作链路接 RAG：`@aichat/rag` 新增 inject.ts（injectContext 迁移）、runner.ts 重新检索并注入、collab-runner 每 run 一次检索注入全部席位。你的工作树不含 A3 修复，先写测试预期红。

## 任务

1. `packages/rag/test/inject.test.ts`（基线红：无此模块）：
   - injectContext 把 hits 包成 `RAG_DATA_<nonce>...END_RAG_DATA_<nonce>` 的 user 消息，system 在前、原始议题最后；budget 不足时逐条弹出证据；citations 映射含 documentId/ordinal/text 截断 200 字。
2. `apps/worker/test/runner-rag.test.ts`（或并入既有 runner 套件文件风格；**只加这一个文件**，别动 root vitest include 之外的目录）：
   - mock `@aichat/rag` 的 retrieve 返回 2 hits → 断言传给 providerFactory 的消息含 RAG_DATA 且原 content 仍在末位；断言收尾 assistant 消息 citations 非空。
   - mock retrieve 抛错 → run 照常 SUCCEEDED（不因 RAG 失败）。
3. `apps/worker/test/collab-rag.test.ts`：
   - 双席位 fake orchestrator（参考既有 collab 测试的 mock 结构）+ mock retrieve 返回 hits → 断言两席位收到的消息都含**同一** nonce 的 RAG_DATA；协作 assistant 消息 citations 保持 `[]`。
   - retrieve 超时/异常 → 协作照常完成零降级标记。

## 硬约束

- 只新增 apps/worker/test/ 与 packages/rag/test/ 下文件。禁碰一切 src/。
- 若既有 runner/collab 套件在 apps/worker/test/ 有可复用的 db/provider 桩，复用它们，别自造第三套。
- 不新增依赖。

## 验收

- 基线上红测输出贴 result.md；既有套件不假红。
