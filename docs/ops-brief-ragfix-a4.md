# A4 — A1 轨配套测试（quota 修复，先红后绿）

【自动化模式】不要中途提问、不要读技能目录、不要浏览器对比、全部做完再退出。结束时在 result.md 写：新增测试文件清单、覆盖点列表、你跑过的命令与结果。

## 背景

A1（另一工作树并行修复中）修 providers 包的 quota 误判：resolver adapter 归一化、quota-provider 判断改 kind+provider、inputTokenUpperBound 覆盖 deepseek 全系。你的工作树**不含 A1 的修复**——你先在未修复基线上写测试，预期红（复现 bug），A1 合并后转绿。

## 任务

在 `packages/providers/test/` 新增 `quota-degradation.test.ts`（或并入既有 resolver/quota 套件风格）：

1. **红测·adapter 归一**：构造 mock db（参考既有测试的 fake store 模式），Provider(kind='deepseek') + ModelRegistry(providerId 指向它, kind='cloud')，断言 `resolve()` 返回 `adapter === 'openai-compatible'`。基线上红（现在返回 'deepseek'）。
2. **红测·不再误降级**：quotaProvider.streamChat 走 deepseek-chat：mock usage 低于 limit、ApiKey 存在（decrypt mock），断言 provider 收到的流来自 OpenAICompatibleProvider 而非 fallback 到本地 ollama（可用注入的 providerFactory 观察请求 model）。基线上红。
3. **红测·reasoner 也有 bound**：`new OpenAICompatibleProvider({model:'deepseek-reasoner',...}).inputTokenUpperBound(msgs)` 返回正数。基线上红（返回 undefined）。
4. **绿测·回归护栏**：ollama 行 adapter 仍为 'ollama'；quota 真超限时（usage ≥ limit）仍正确 fallback 降级（保底语义不丢）。

## 硬约束

- 只新增/修改 packages/providers/test/ 下文件。禁碰 src/。
- mock 注意 Prisma tagged-template 断言取 `calls[i].slice(1)` 的既有坑。
- 不新增依赖。

## 验收

- 基线上跑：1-3 红、4 绿（在 result.md 里贴命令输出摘要证明先红）。
- 全套件其余用例不因你的 mock 引入假红。
