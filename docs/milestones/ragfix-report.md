# ragfix 修复报告（2026-09-29）

基线 tag：`pre-rag-quota-fix`（738dc2e）→ 修复后 HEAD：e26d898

## 用户症状

"多模型协作与正常问答无法依据知识库进行回答"

## 根因（5 处，全部实证）

| # | 根因 | 位置 | 修复轨道 |
|---|------|------|---------|
| ① | 云模型 adapter='deepseek' vs 判断 '==='openai-compatible'' 永假 → DeepSeek 100% 误判 QUOTA_EXCEEDED 降级到本地小模型裸答 | resolver.ts / quota-provider.ts | A1 |
| ② | inputTokenUpperBound 只覆盖 deepseek-chat，reasoner 仍降级 | openai-compatible.ts | A1 |
| ③ | RAG 检索 3s 双层死线，热态 2.8s 贴线冷态必超 → hits=[] 不注入 | rag-context.ts / retrieve.ts / llm-json.ts | A2 |
| ④ | worker 执行路径与协作链路完全没有 RAG 注入 | runner.ts / collab-runner.ts | A3 |
| ⑤ | 注入门 2048 字节 < 单条 hit 序列化最小 2239 字节 → 一条证据都塞不进 | inject.ts | A11（验收中发现，编排方直修 e26d898） |

## 执行编队（11 agent，两波）

- 第一波 6：A1 quota修复(codex) / A2 预算(codex) / A3 worker+collab接RAG(codex) / A4-A6 配套红转绿测试(codex)
- 第二波 5：A7 全量审查(codex，报1 major：worker恢复重放引用漂移——仅worker模式激活，入backlog) / A8 对抗审查(claude，17场景过10、成立7全minor，结论可合并) / A9 E2E真跑(编排方) / A10 本报告+台账 / A11 机动兜底(触发，修根因⑤)

## 验收证据（全部真跑）

1. **普通对话链**（run cmumdzjbi…→cmumehgo 前后多次）：deepseek-chat 真实调用（ProviderCall modelId=deepseek-chat 注册表 id）、零 QUOTA_EXCEEDED、citations=5、回答基于 KB 实际内容且带 [documentId][ordinal] 引用标记
2. **协作链**（run cmumehgod006mequam0p2rrwf）：GROUP 双席位(qwen3:8b+0.6b) SUCCEEDED，席位产出明确引用 KB 内容（temperature/top_p 调优、CUDA/cuDNN 安装）
3. **页面回归**：/qa /kb /api/conversations 全 200
4. **测试**：repo 根 393 passed | 34 skipped 全绿；worker RAG 独立套件 5/5；typecheck 全包过；.js 后缀残留 grep 零命中

## 质量基线

- vitest：根 393 绿（基线前 393，无回归）；新增约 20 用例
- typecheck：全部 9 包通过，无新增错误

## 已知局限（backlog）

1. [major] worker 恢复路径重放缓存答案可能挂新检索的引用（A7#1）——仅 EXECUTION_MODE=worker 激活，当前 inline 不触发；修法=按调用身份持久化 citations
2. [minor] collab 回落单席 processRun 时静默丢 RAG（A8 5.2）
3. [minor] 8s 窗口放大跨重启孤儿 SSE 会话重发（A8 4.3）等 7 项 minor，见 a8-result.md
4. EXECUTION_MODE 仍为 inline；切 worker 模式是独立工作单（Q3 决策）

## 证据文件

- 审查报告：/mnt/e/Hermes/cache/scratch/ragfix-logs/a7-result.md、a8-result.md
- 六轨 agent 报告：docs/ragfix-reports/
- E2E 数据库证据：OrchestrationRun cmumdzjbi001e81uaspg5hzjc（普通链）、cmumehgod006mequam0p2rrwf（协作链）
