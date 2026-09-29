# A7 — 全量代码审查（ragfix 合并后）

【自动化模式】只读审查,不改任何文件。结束时在 result.md 输出结构化审查报告。

## 审查对象

main 分支上 `git log pre-rag-quota-fix..main` 的全部提交（ragfix 六轨:A1 quota误判修复/A2 RAG预算/A3 worker+collab接RAG/A4-A6 配套测试）。

## 审查重点(按严重度排序输出)

1. **quota 语义回归**:adapter 归一化后,是否还有隐藏的 `adapter === 'deepseek'` 旧判断残留(grep 全仓);真超限 fallback 保底是否仍工作;并发预约(pg_advisory_xact_lock 路径)是否被改动波及。
2. **RAG 注入一致性**:web inline 路径与 worker 路径的注入行为是否等价(RAG_DATA nonce 格式/system位置/议题末位);collab 幂等(重试不重复注入)实现是否可靠。
3. **预算扩容副作用**:8s 死线是否会阻塞 SSE 首 token 过久;llm-json 6s 对 qwen3:0.6b 改写的实际耗时余量;超时降级路径是否仍完整(RAG_UNAVAILABLE 语义)。
4. **测试质量**:A4-A6 的红测是否真的红过(测试是否只测了 mock 而非行为);mock 的 fake store 是否按输入区分返回值。
5. **跨包边界**:packages/rag 新增 inject.ts 的导出是否破坏既有消费者;相对导入 .js 后缀残留(grep `from '[^']*\.js'` packages/*/src apps/web/src apps/worker/src)。

## 输出格式

每条发现: [severity: blocker/major/minor] 文件:行号 问题描述 + 最小修复建议。最后给整体结论:可合并/需修复后合并。
