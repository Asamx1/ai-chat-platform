审查结论：**需修复后合并**。

1. **[severity: major] [runner.ts:363](/home/codex/code/ai-chat-platform/wt-a7/apps/worker/src/runner.ts:363)：恢复执行可能给旧答案挂上新引用。**  
   worker 每次恢复都会重新检索并生成 `prompt.citations`；但 quotaProvider 对已结算调用直接重放缓存答案。若首次调用结算后、消息落库前进程退出，恢复时知识库发生变化，最终会保存“旧答案＋新引用”，检索失败时还会清空引用。现有恢复测试 mock 掉了 quotaProvider，未覆盖这条路径。  
   **最小修复建议：**按调用身份持久化实际使用的证据和 citations，重放答案时恢复同一份引用；补充结算后崩溃、证据变化的恢复测试。

2. **[severity: minor] [collab-runner.ts:124](/home/codex/code/ai-chat-platform/wt-a7/apps/worker/src/collab-runner.ts:124)：前缀去重会把用户文本误认作已注入证据。**  
   任意消息只要以 `RAG_DATA_` 开头，就跳过真实证据及其系统指令，无需合法 nonce 或完整包。用户粘贴此类文本、或席位 systemPrompt 使用此前缀，都会导致已检索到的知识库内容不进入模型。现有“恢复幂等”测试实际把该文本放进用户议题，反而固化了误判。  
   **最小修复建议：**根据内部保存的证据消息及 nonce 去重，不以任意消息前缀判定；补充用户文本包含同名前缀的测试。

其他核查结果：

- 未发现生产源码残留 `adapter === 'deepseek'` 旧判断或指定范围内相对导入 `.js` 后缀；超限 fallback 分支仍在，预约锁实现未改动。
- 6 秒是 llm-json 上限；实际 rewrite 调用仍被限制为 **800ms**，不能据此认定改写获得了 6 秒余量。请求前检索与执行前校验／重检索串行，首 token 等待也不受单个 8 秒预算整体约束。
- A4–A6 报告包含基线失败记录；部分测试验证真实执行行为，但 mock 未验证真实 PostgreSQL 并发锁，也未覆盖上述缓存重放问题。
- 已运行无文件写入的 Node 断言，验证共享注入顺序、nonce、citations、输入不变及预算常量，全部通过。当前工作树无依赖目录，未重跑完整套件或实测模型延迟。

全程未修改文件。A7 简报从同仓库主工作树读取；按本次只读要求，未写入 `result.md`。