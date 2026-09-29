# A1 quota 降级误判修复结果

已完成：默认 adapter 按 ollama / openai-compatible 归一化，保留显式 adapter；DeepSeek 云模型额度上界判断改用 kind 和 provider；字节上界覆盖 deepseek 前缀全系模型，公式不变。

## 改动文件

- `packages/providers/src/resolver.ts`
- `packages/providers/src/quota-provider.ts`
- `packages/providers/src/openai-compatible.ts`
- `packages/providers/test/resolver.test.ts`
- `packages/providers/test/deepseek-adapter.test.ts`
- `packages/providers/test/quota-provider-deepseek.test.ts`（新增）
- `result.md`（本交付记录）

新依赖：无。未修改 apps、packages/rag 或数据库 schema；新增相对导入均不带 .js 后缀，未新增可选字段。

## 复用点

- 复用原 resolver、Ollama 分支、OpenAICompatibleProvider 字节上界公式。
- 回归测试复用真实 resolver、reserveQuota、finishQuota 和 SSE 解析，仅模拟数据库与 HTTP 响应。
- chat / reasoner 分别覆盖 adapter=null 的实际数据库配置及显式 adapter=deepseek 的兼容配置，验证低用量下不降级、预留额度为 621、调用正确云模型并结算。
- 复用 resolver 测试夹具验证默认归一化、显式 adapter 保留；已有 Ollama 分支测试继续通过。

## 验证命令与结果

在 `/home/codex/code/ai-chat-platform/wt-a1` 执行：

1. `rg -n 'adapter' experiments apps/worker/test apps/web/test packages/providers/test`
   - 未发现断言 adapter='deepseek' 的既有测试，无需修改其它包。
2. `./node_modules/.bin/vitest run packages/providers/test`
   - 最终通过：7 个测试文件，49 个用例，包括已有 Ollama live 测试。
3. `node /home/codex/code/ai-chat-platform/repo/apps/web/node_modules/typescript/bin/tsc -p packages/providers/tsconfig.json --noEmit --incremental false`
   - 最终通过，退出码 0。
4. `git diff --check`
   - 通过，无空白错误。

当前 worktree 未安装依赖。首次测试及类型检查因缺少 @aichat/contracts、@aichat/crypto 的解析链接失败；通过下列临时链接复用主仓已安装依赖后，上述测试和类型检查均通过：

```sh
ln -s /home/codex/code/ai-chat-platform/repo/node_modules node_modules
ln -s /home/codex/code/ai-chat-platform/repo/packages/providers/node_modules packages/providers/node_modules
```

验证结束后已移除这两个临时链接，未安装或改动依赖及锁文件。若在本 worktree 重跑，需先恢复依赖链接或按仓库既有方式准备依赖。
