# A4 quota 回归测试结果

基线：`c792414`。仅新增测试目录内文件，未修改 `src/`，未新增依赖。

## 新增文件

- `packages/providers/test/quota-degradation.test.ts`
- `packages/providers/test/result.md`（本报告放在测试目录内，以遵守修改范围约束）

## 覆盖点与先红证据

新增 6 个用例，基线上 **3 failed / 3 passed**，失败均为普通断言，未使用 `it.fails` 或跳过。

| 覆盖点 | 基线结果 |
| --- | --- |
| Provider.kind=deepseek、ModelRegistry.kind=cloud、adapter=null，DB API Key 经 mock 解密后 resolve | 红：期望 openai-compatible，实际 deepseek |
| usage=30、limit=200000，deepseek-chat 通过真实 quotaProvider 和真实流式适配器发送请求 | 红：期望 DeepSeek `/chat/completions`，实际 Ollama `/api/chat`，model=qwen3:0.6b |
| deepseek-reasoner 的 inputTokenUpperBound 为正数 | 红：实际 undefined |
| 本地 Ollama 的 adapter 仍为 ollama，不查询凭据和用量 | 绿 |
| usage=limit 时降级，回调 QUOTA_EXCEEDED、本地流、零云端预留、正常结算 | 绿 |
| usage>limit 时同样正确降级 | 绿 |

低用量流测试还断言 DB 密钥进入 Authorization、无 fallback 查询、无 degraded 标记、按输入 bound + maxTokens 预留、返回云端文本并结算实际 usage。

采用既有 fake store 风格；不 mock resolver、quotaProvider 或适配器类。只 mock 解密、配额持久化模块和 HTTP fetch。每例 resetAllMocks，结束后 unstubAllGlobals。没有 SQL/tagged-template 参数断言，因此不涉及首参数偏移问题。真实 SQL 配额预留/结算不是本文件的验证范围。

## 执行环境与命令

原工作树执行 `pnpm exec vitest run packages/providers/test/quota-degradation.test.ts`：退出 127，`pnpm: command not found`；工作树也没有 node_modules。

为保持修改范围，使用临时目录 `/tmp/ragfix-a4-b9ucJn`：

```sh
git archive HEAD | tar -x -C /tmp/ragfix-a4-b9ucJn
cp packages/providers/test/quota-degradation.test.ts /tmp/ragfix-a4-b9ucJn/packages/providers/test/
```

使用 Python pathlib 将临时副本的根目录及各包 node_modules 链接到 `/home/codex/code/ai-chat-platform/repo` 中已有依赖；未安装依赖、未修改其他工作树文件。以下命令在临时副本中运行，`VITEST` 表示 `/home/codex/code/ai-chat-platform/repo/node_modules/.bin/vitest`，`TSC` 表示同目录下的 `tsc`。

| 命令 | 结果 |
| --- | --- |
| `$VITEST run packages/providers/test/quota-degradation.test.ts` | 退出 1；3 failed / 3 passed，准确复现上述三个问题 |
| `$VITEST run packages/providers/test --reporter=dot` | 退出 1；1 failed / 6 passed 文件，3 failed / 40 passed 用例；原有 37 个用例全部通过 |
| `$TSC -p packages/providers/tsconfig.json --noEmit --incremental false` | 首次发现 fake SQL 泛型 mock 类型错误；改为抛错的 Promise<never> 方法后重跑，退出 0 |
| `$VITEST run --reporter=dot` | 退出 1；2 failed / 43 passed / 4 skipped 文件；4 failed / 366 passed / 34 skipped 用例 |
| `$VITEST run --exclude packages/providers/test/quota-degradation.test.ts --reporter=dot` | 退出 1；1 failed / 43 passed / 4 skipped 文件；1 failed / 363 passed / 34 skipped 用例 |
| `git diff --check`（原工作树） | 退出 0 |

类型修正后同步临时测试文件，并重跑 providers 全套，结果仍为 3 failed / 40 passed。

根套件额外失败为 `packages/rag/test/queue.test.ts:32` 的 permanent error 分支：期望 `['PENDING','FAILED','FAILED']`，实际 `['PENDING','FAILED','PENDING']`。排除新增文件后仍完全复现，说明不是本次 mock 引入；该结果来自复用依赖的临时环境，未将其断言为生产缺陷。其余测试结果一致。

本次交付是未修复基线上的红测。未合入或修改 A1 的生产代码，合并 A1 后需重跑确认转绿。
